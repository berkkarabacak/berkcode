// The sign-in page of the web version. After signing in, it goes back to the page that was asked for (its #part).
const form = document.querySelector('#login-form');
const input = document.querySelector('#password');
const msg = document.querySelector('#login-msg');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  msg.textContent = '';
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: input.value }) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      location.replace(`/${location.hash}`);
      return;
    }
    msg.textContent = data.error || 'Signing in did not work. Please try again.';
    input.select();
  } catch {
    msg.textContent = 'The app cannot be reached right now. Check the internet connection and try again.';
  } finally {
    button.disabled = false;
  }
});
