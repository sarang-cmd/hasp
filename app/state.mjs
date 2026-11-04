// Demonstration metadata only. Never place credentials in these records.
export const sampleItems = Object.freeze([
  { id: '1', service: 'Groq', name: 'Groq production', domain: 'console.groq.com', environment: 'production', type: 'API key', brand: 'groq' },
  { id: '2', service: 'Groq', name: 'Groq staging', domain: 'console.groq.com', environment: 'staging', type: 'API key', brand: 'groq' },
  { id: '3', service: 'Stripe', name: 'Stripe secret key', domain: 'dashboard.stripe.com', environment: 'production', type: 'API key', brand: 'stripe' },
  { id: '4', service: 'GitHub', name: 'GitHub token, deploys', domain: 'github.com', environment: 'production', type: 'Personal token', brand: 'github' },
  { id: '5', service: 'Neon', name: 'Neon connection', domain: 'console.neon.tech', environment: 'production', type: 'Connection string', brand: 'neon' },
  { id: '6', service: 'Cloudflare', name: 'Cloudflare R2 token', domain: 'dash.cloudflare.com', environment: 'production', type: 'API key', brand: 'cloudflare' },
  { id: '7', service: 'Linear', name: 'Linear API key', domain: 'linear.app', environment: 'production', type: 'API key', brand: 'linear' },
  { id: '8', service: 'GitHub', name: 'GitHub recovery codes', domain: 'github.com', environment: 'personal', type: 'Backup codes', brand: 'github' }
]);

export function filterItems(items, { query = '', type = 'All', environment = 'all' } = {}) {
  const normalized = query.trim().toLocaleLowerCase();
  return items.filter(item => {
    const matchesQuery = [item.name, item.service, item.domain, item.environment, item.type].some(value => value.toLocaleLowerCase().includes(normalized));
    return matchesQuery && (type === 'All' || item.type === type) && (environment === 'all' || item.environment === environment);
  });
}
