import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parse } from 'yaml';
import {
  incidentCoverage,
  nextIncidentId,
  parseIncident,
  readIncidents,
  summarize,
  type Incident,
} from '../framework/incidents.ts';
import { readProject } from '../framework/project.ts';
import { incidentsRule } from './guard.ts';
import { incidentAdd, incidentReport, planScenarioIds, withIncidentScenario } from './incident.ts';
import { EXIT } from './output.ts';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const INC = (id: string, extra = '') =>
  `title: Refunds above the order total were accepted\ndate: 2026-11-19\nscenario: ${id}\n${extra}`;

function incident(id: string, extra: Partial<Incident> = {}): Incident {
  return { id, title: id, date: '2026-11-19', scenario: id, status: 'open', file: `incidents/${id}.yaml`, ...extra };
}

describe('incident files', () => {
  it('reads a valid incident and refuses what would let one vanish or lie', () => {
    const ok = parseIncident(INC('INC-3', 'missedBy: missing-scenario\nticket: OPS-412\n'), 'incidents/INC-3.yaml');
    assert.equal(ok.id, 'INC-3');
    assert.equal(ok.missedBy, 'missing-scenario');
    assert.equal(ok.status, 'open');
    assert.throws(() => parseIncident(INC('INC-3'), 'incidents/bug.yaml'), /named INC-<n>\.yaml/);
    assert.throws(() => parseIncident('date: 2026-11-19\nscenario: INC-1\n', 'incidents/INC-1.yaml'), /title/);
    assert.throws(() => parseIncident(INC('INC-2'), 'incidents/INC-1.yaml'), /scenario must be INC-1/);
    assert.throws(
      () => parseIncident(INC('INC-1', 'missedBy: not-testable\n'), 'incidents/INC-1.yaml'),
      /not-testable needs a reason/,
    );
    assert.throws(() => parseIncident(INC('INC-1', 'missedBy: bad-luck\n'), 'incidents/INC-1.yaml'), /missedBy/);
  });

  it('never reuses a number, even after one was deleted', () => {
    assert.equal(nextIncidentId([]), 'INC-1');
    assert.equal(nextIncidentId([incident('INC-1'), incident('INC-4')]), 'INC-5');
  });
});

describe('incident coverage', () => {
  it('guards an incident only with its scenario in the plan and a collected test carrying its whole id', () => {
    const states = incidentCoverage(
      [
        incident('INC-1'),
        incident('INC-2'),
        incident('INC-3'),
        incident('INC-4', { missedBy: 'not-testable', reason: 'a race only under production load' }),
      ],
      new Set(['INC-1', 'INC-2']),
      // INC-2 is only a prefix of INC-21's title: not guarded.
      'POST /refunds › [INC-1] refuses a refund above the order total\nGET /x › [INC-21] something else',
    );
    assert.deepEqual(
      states.map((s) => s.state),
      ['guarded', 'no-test', 'no-scenario', 'exempt'],
    );
    assert.match(states[1].detail, /incident INC-2 has no regression test/);
    assert.match(states[2].detail, /no scenario in the plan/);
    const report = summarize(states);
    assert.deepEqual(
      { total: report.total, guarded: report.guarded, exempt: report.exempt, unguarded: report.unguarded },
      { total: 4, guarded: 1, exempt: 1, unguarded: 2 },
    );
    assert.equal(report.catchRate, 0.333);
  });
});

describe('vgate incident add and report', () => {
  function project(): string {
    const root = mkdtempSync(join(tmpdir(), 'vgate-incident-'));
    dirs.push(root);
    writeFileSync(join(root, 'vgate.yaml'), 'version: 0.4.0\nservicesDir: regression\n');
    mkdirSync(join(root, 'regression/orders'), { recursive: true });
    writeFileSync(join(root, 'regression/orders/service.yaml'), 'name: orders\n');
    writeFileSync(
      join(root, 'regression/orders/inventory.yaml'),
      '# The plan of orders.\nservice: orders\noperations:\n  - id: create\n    scenarios:\n      - id: ORD-201 # the happy path\n',
    );
    return root;
  }

  it('records the incident, adds its scenario to the plan keeping the comments, and numbers the next one', () => {
    const root = project();
    const first = incidentAdd(readProject(root), {
      service: 'orders',
      title: 'Refunds above the order total were accepted',
      ticket: 'OPS-412',
      missedBy: 'missing-scenario',
      date: '2026-11-19',
    });
    assert.equal(first.exitCode, EXIT.ok);
    const record = parseIncident(
      readFileSync(join(root, 'regression/orders/incidents/INC-1.yaml'), 'utf8'),
      'incidents/INC-1.yaml',
    );
    assert.equal(record.ticket, 'OPS-412');
    const plan = readFileSync(join(root, 'regression/orders/inventory.yaml'), 'utf8');
    assert.match(plan, /# The plan of orders\./);
    assert.match(plan, /# the happy path/);
    assert.deepEqual([...planScenarioIds(parse(plan))].sort(), ['INC-1', 'ORD-201']);
    const second = incidentAdd(readProject(root), { service: 'orders', title: 'Second', date: '2026-11-19' });
    assert.equal((second.data as { id: string }).id, 'INC-2');
    assert.deepEqual(
      readIncidents(join(root, 'regression/orders')).map((i) => i.id),
      ['INC-1', 'INC-2'],
    );
    const report = incidentReport(readProject(root), 'orders');
    assert.match(report.summary, /2 incidents: 0 guarded/);
  });

  it('refuses not-testable without a reason, and keeps such an incident out of the plan', () => {
    const root = project();
    assert.throws(
      () => incidentAdd(readProject(root), { service: 'orders', title: 'x', missedBy: 'not-testable' }),
      /needs --reason/,
    );
    incidentAdd(readProject(root), { service: 'orders', title: 'x', missedBy: 'not-testable', reason: 'load only' });
    assert.ok(!readFileSync(join(root, 'regression/orders/inventory.yaml'), 'utf8').includes('INC-1'));
  });

  it('appends to an existing incidents section', () => {
    const once = withIncidentScenario('service: s\n', { id: 'INC-1' });
    const twice = withIncidentScenario(once, { id: 'INC-2' });
    assert.deepEqual([...planScenarioIds(parse(twice))], ['INC-1', 'INC-2']);
  });
});

describe('guard: incident-dropped', () => {
  const file = 'regression/orders/incidents/INC-1.yaml';
  const rules = (base: Record<string, string>, head: Record<string, string>) =>
    incidentsRule(new Map(Object.entries(base)), new Map(Object.entries(head)));

  it('needs a human to delete an incident, re-point its scenario or newly call it not testable', () => {
    const before = INC('INC-1', 'missedBy: missing-scenario\n');
    assert.deepEqual(
      rules({ [file]: before }, {}).findings.map((f) => f.detail),
      ['incident deleted'],
    );
    assert.match(
      rules({ [file]: before }, { [file]: before.replace('scenario: INC-1', 'scenario: ORD-201') }).findings[0].detail,
      /scenario INC-1 -> ORD-201/,
    );
    assert.match(
      rules(
        { [file]: before },
        { [file]: before.replace('missedBy: missing-scenario', 'missedBy: not-testable\nreason: later') },
      ).findings[0].detail,
      /not-testable/,
    );
  });

  it('takes a new incident, or an unchanged one, as nothing weakened', () => {
    const before = INC('INC-1');
    const added = rules({}, { [file]: before });
    assert.deepEqual(added.findings, []);
    assert.equal(added.info[0].detail, 'incident recorded');
    assert.deepEqual(rules({ [file]: before }, { [file]: `${before}status: guarded\n` }).findings, []);
  });
});
