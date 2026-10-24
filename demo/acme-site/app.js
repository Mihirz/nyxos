// Tandem marketing site: navigation + call-to-action wiring.

const ROUTES = {
  home: '/',
  features: '/#features',
  pricing: '/pricing',
  signup: '/signup',
};

const NAV_ITEMS = [
  { label: 'Features', route: 'features' },
  { label: 'Pricing', route: 'pricing' },
  { label: 'Sign in', route: 'home' },
];

function link(label, href) {
  const a = document.createElement('a');
  a.textContent = label;
  a.href = href;
  return a;
}

function renderNav() {
  const nav = document.getElementById('nav');
  for (const item of NAV_ITEMS) {
    nav.appendChild(link(item.label, ROUTES[item.route]));
  }
}

function trackClick(name) {
  // Analytics stub: in production this posts to /events.
  console.debug('click', name);
}

function wireCallToAction() {
  const cta = document.getElementById('cta');
  cta.addEventListener('click', () => trackClick('cta'));
  // The beta signup button on the landing page.
  cta.href = '/singup';
}

renderNav();
wireCallToAction();
