// Node's --env-file preserves inherited variables. Merge both spellings here
// so an inherited NO_PROXY cannot hide the project's DeepSeek exclusion.
const exclusions = [...new Set([
  ...(process.env.NO_PROXY ?? '').split(','),
  ...(process.env.no_proxy ?? '').split(','),
  'localhost', '127.0.0.1', '::1', 'api.deepseek.com',
].map(value => value.trim()).filter(Boolean))].join(',');
process.env.NO_PROXY = exclusions;
process.env.no_proxy = exclusions;
