// example-web's page logic: sign in with an API key, list notes, add one (README rules 1-5).
const state = { key: '' };
const $ = (id) => document.getElementById(id);

async function call(method, path, body) {
  const headers = { 'X-Api-Key': state.key };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
}

function render(items) {
  const list = $('list');
  list.replaceChildren(
    ...items.map((note) => {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = note.title;
      item.append(title);
      if (note.body) item.append(document.createTextNode(` — ${note.body}`));
      return item;
    }),
  );
}

async function refresh() {
  const { status, data } = await call('GET', '/notes?limit=20');
  if (status === 200) render(data.items);
}

$('signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.key = $('key').value;
  const { status } = await call('GET', '/notes?limit=20');
  if (status !== 200) {
    $('signin-error').textContent = 'That key was not accepted.';
    return;
  }
  $('signin-error').textContent = '';
  $('signin').hidden = true;
  $('notes').hidden = false;
  await refresh();
});

$('new-note').addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = $('title').value.trim();
  if (title === '') {
    $('form-error').textContent = 'Title is required.';
    $('title').setAttribute('aria-invalid', 'true');
    return;
  }
  $('title').removeAttribute('aria-invalid');
  const body = $('body').value.trim();
  const { status } = await call('POST', '/notes', { title, ...(body ? { body } : {}) });
  if (status === 403) {
    $('form-error').textContent = 'Your key may only read notes.';
    return;
  }
  if (status !== 201) {
    $('form-error').textContent = 'The note could not be saved.';
    return;
  }
  $('form-error').textContent = '';
  $('title').value = '';
  $('body').value = '';
  await refresh();
});
