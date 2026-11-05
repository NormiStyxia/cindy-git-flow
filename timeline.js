(function (scope) {
  'use strict';
  // Maker 实际标题：`[1793783174615] sync at 2026/11/4 17:06:14`。
  // 标题模板固定、作者是 Maker，所以两者一起判断；认错只影响显示，不会改动仓库。
  // 兼容斜杠/短横线及未补零的月、日、小时；不能把文档里的日期格式当真实数据。
  const SYNC_SUBJECT = /^\[\d{9,16}\]\s*sync(?:\s+at)?\s+\d{4}([/-])\d{1,2}\1\d{1,2}[ T]\d{1,2}:\d{2}/i;
  const GROUP_PREFIX = 'auto:';
  function isAutoSubject(subject) {
    return SYNC_SUBJECT.test(String(subject ?? '').trim());
  }
  function isAutoCommit(commit) {
    if (!commit || !isAutoSubject(commit.subject)) return false;
    const author = String(commit.author ?? '').trim(), email = String(commit.email ?? '').trim();
    // 只有标题可用时按格式判断，拿到作者信息后再收紧一次。
    if (!author && !email) return true;
    return /^maker$/i.test(author) || /@taptap\.(?:cn|com)$/i.test(email);
  }
  const parentsOf = commit => Array.isArray(commit.parents) ? commit.parents : [];
  // 连续的自动同步提交收成一行；其余提交原样保留。
  // 返回的 parents 已指向折叠后的行，分支图和泳道不用理解"折叠"这个概念。
  function build(commits, options) {
    const fold = options?.fold !== false;
    const source = Array.isArray(commits) ? commits.filter(c => c && typeof c.sha === 'string') : [];
    const auto = source.map(isAutoCommit);
    // joins[k]：第 k 条快照正好是第 k-1 条的父提交，只有这种首尾相接的才算同一条同步链。
    const joins = source.map((commit, k) => k > 0 && auto[k] && auto[k - 1] && parentsOf(source[k - 1]).length === 1 && parentsOf(source[k - 1])[0] === commit.sha);
    const items = [], bySha = new Map(), toDisplay = new Map();
    const autoCount = auto.filter(Boolean).length;
    let folded = 0;
    for (let i = 0; i < source.length; i++) {
      const commit = source[i];
      // 一条同步链只有两条以上才值得折叠；单条快照照常显示成一行。
      if (fold && auto[i] && !joins[i] && joins[i + 1]) {
        const members = [commit];
        while (joins[i + 1]) { i++; members.push(source[i]); }
        const tail = members[members.length - 1];
        const item = {
          sha: GROUP_PREFIX + commit.sha, author: commit.author, email: commit.email, date: commit.date, subject: commit.subject,
          parents: parentsOf(tail).slice(),
          auto: { folded: true, count: members.length, members, newestDate: commit.date, oldestDate: tail.date }
        };
        items.push(item); bySha.set(item.sha, item);
        for (const member of members) toDisplay.set(member.sha, item.sha);
        folded += members.length - 1;
        continue;
      }
      const item = { ...commit, parents: parentsOf(commit).slice(), auto: auto[i] ? { folded: false, count: 1, members: [commit], newestDate: commit.date, oldestDate: commit.date } : null };
      items.push(item); bySha.set(item.sha, item); toDisplay.set(commit.sha, commit.sha);
    }
    for (const item of items) {
      const next = [];
      for (const parent of item.parents) {
        const target = toDisplay.get(parent) ?? parent;
        if (target !== item.sha && !next.includes(target)) next.push(target);
      }
      item.parents = next;
    }
    return { items, bySha, folded, auto: autoCount, shaOf: sha => (typeof sha === 'string' && toDisplay.get(sha)) || sha };
  }
  scope.GitTimeline = { build, isAutoCommit, isAutoSubject };
  if (typeof module !== 'undefined') module.exports = scope.GitTimeline;
})(typeof window !== 'undefined' ? window : globalThis);
