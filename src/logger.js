const config = require('./config');

// Lightweight logger without winston — the thin agent keeps dependencies minimal.
// Format matches the worker: "YYYY-MM-DD HH:MM:SS [LEVEL] message".
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(level, message, meta) {
  if (LEVELS[level] > threshold) return;
  const metaStr = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  const line = `${ts()} [${level.toUpperCase()}] ${message}${metaStr}`;
  (level === 'error' ? console.error : console.log)(line);
}

module.exports = {
  error: (m, meta) => log('error', m, meta),
  warn: (m, meta) => log('warn', m, meta),
  info: (m, meta) => log('info', m, meta),
  debug: (m, meta) => log('debug', m, meta),
};
