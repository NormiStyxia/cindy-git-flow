(function (scope) {
  const PALETTE = 8;
  // 每条分支沿自己的泳道走到父提交那一行再汇入，不会和别的线叠在同一条泳道上。
  function layout(commits) {
    const index = new Map(commits.map((c, i) => [c.sha, i]));
    const active = [], rows = [], links = [];
    const free = () => { const n = active.indexOf(null); return n < 0 ? active.length : n; };
    commits.forEach((commit, row) => {
      const waiting = [];
      active.forEach((sha, i) => { if (sha === commit.sha) waiting.push(i); });
      const lane = waiting.length ? waiting[0] : free();
      for (const i of waiting) active[i] = null;
      active[lane] = null;
      rows.push({ ...commit, lane, row, color: lane % PALETTE });
      commit.parents.forEach((parent, k) => {
        const boundary = !index.has(parent);
        let travel;
        if (k === 0) travel = lane;
        else { const existing = active.indexOf(parent); travel = existing >= 0 ? existing : free(); }
        // 窗口外的父提交只画一小段虚线，不长期占用泳道。
        active[travel] = boundary ? null : parent;
        links.push({ from: commit.sha, to: parent, fromRow: row, fromLane: lane, lane: travel, first: k === 0, boundary });
      });
    });
    const bySha = new Map(rows.map(r => [r.sha, r]));
    for (const link of links) {
      const target = bySha.get(link.to);
      link.toRow = target ? target.row : link.fromRow + 1;
      link.toLane = target ? target.lane : link.lane;
      link.color = link.lane % PALETTE;
    }
    // 每行实际被占用的最右泳道，正文紧跟在图后面开始。
    const reach = rows.map(r => r.lane);
    const bump = (row, lane) => { if (row >= 0 && row < reach.length && lane > reach[row]) reach[row] = lane; };
    for (const link of links) {
      bump(link.fromRow, Math.max(link.fromLane, link.lane));
      const end = link.boundary ? link.fromRow + 1 : link.toRow;
      for (let r = link.fromRow + 1; r < end; r++) bump(r, link.lane);
      if (!link.boundary) bump(link.toRow, Math.max(link.lane, link.toLane));
    }
    const lanes = rows.reduce((n, r, i) => Math.max(n, reach[i] + 1), 0);
    return { rows, links, reach, lanes };
  }
  // 沿 first-parent 往下的主线，用来画流动高亮。
  function trunk(layoutResult, sha) {
    const bySha = new Map(layoutResult.rows.map(r => [r.sha, r]));
    const firstLink = new Map(layoutResult.links.filter(l => l.first).map(l => [l.from, l]));
    const chain = []; let cursor = sha; const seen = new Set();
    while (cursor && bySha.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor); const link = firstLink.get(cursor); if (!link) break;
      chain.push(link); cursor = link.boundary ? null : link.to;
    }
    return chain;
  }
  scope.GitGraph = { layout, trunk, PALETTE };
  if (typeof module !== 'undefined') module.exports = scope.GitGraph;
})(typeof window !== 'undefined' ? window : globalThis);
