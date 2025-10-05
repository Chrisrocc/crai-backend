// src/services/matching/levenshtein.js
function levenshtein(a = '', b = '') {
  const s = String(a); const t = String(b);
  const m = s.length; const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    const si = s.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const tj = t.charCodeAt(j - 1);
      const cost = (si === tj) ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return dp[m][n];
}

module.exports = { levenshtein };
