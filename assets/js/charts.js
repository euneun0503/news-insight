// Chart.js 래퍼 (페이지 이동 시 이전 차트 정리)
import { short, fmt, dayLabel, dayTitle, dayKind, DAY_COLOR } from "./util.js";

const live = new Set();

export function destroyCharts() {
  for (const c of live) c.destroy();
  live.clear();
}

// opts.days = ["YYYY-MM-DD", …] 를 넘기면 x축에 요일·공휴일 표시 (주말·공휴일 색 구분)
function base(extra = {}) {
  const { days, ...rest } = extra;
  const o = baseOpts(rest);
  if (days) {
    o.scales.x.ticks.color = (c) => DAY_COLOR[dayKind(days[c.tick?.value ?? c.index] || "")] || "#8592a6";
    o.plugins.tooltip.callbacks.title = (items) => (items[0] ? dayTitle(days[items[0].dataIndex]) : "");
  }
  return o;
}

function baseOpts(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: "rectRounded", font: { size: 12 }, padding: 12 } },
      tooltip: {
        backgroundColor: "#0f2341", padding: 10, titleFont: { weight: "600" }, bodySpacing: 4,
        itemSort: (a, b) => b.raw - a.raw,
        callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.raw)}` },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 11 }, color: "#8592a6", maxRotation: 0, autoSkipPadding: 12 } },
      y: { beginAtZero: true, grid: { color: "#eef1f6" }, border: { display: false }, ticks: { font: { size: 11 }, color: "#8592a6", callback: (v) => short(v) } },
    },
    ...extra,
  };
}

function make(canvas, config) {
  if (!window.Chart) return null;
  window.Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  const c = new window.Chart(canvas, config);
  live.add(c);
  return c;
}

export function lineChart(canvas, labels, datasets, opts = {}) {
  return make(canvas, {
    type: "line",
    data: {
      labels,
      datasets: datasets.map((d) => ({
        borderWidth: d.bold ? 3 : 1.8,
        pointRadius: labels.length > 40 ? 0 : 2.5,
        pointHoverRadius: 4,
        tension: 0.25,
        backgroundColor: d.color,
        borderColor: d.color,
        ...d,
      })),
    },
    options: base(opts),
  });
}

export function barChart(canvas, labels, datasets, opts = {}) {
  const { stacked, ...rest } = opts;
  opts = rest;
  const o = base(opts);
  if (opts.horizontal) {
    o.indexAxis = "y";
    o.scales = {
      x: { ...o.scales.y },
      y: { grid: { display: false }, ticks: { font: { size: 12 }, color: "#4a5568" } },
    };
  }
  if (datasets.length === 1) o.plugins.legend.display = false;
  if (stacked) { o.scales.x = { ...o.scales.x, stacked: true }; o.scales.y = { ...o.scales.y, stacked: true }; }
  return make(canvas, {
    type: "bar",
    data: { labels, datasets: datasets.map((d) => ({ borderRadius: 4, maxBarThickness: 28, ...d })) },
    options: o,
  });
}

// 막대 + 선 (좌/우 축)
export function comboChart(canvas, labels, bar, line, opts = {}) {
  const o = base(opts);
  o.scales.y1 = { position: "right", beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { font: { size: 11 }, color: "#c2410c", callback: (v) => short(v) } };
  return make(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { type: "bar", borderRadius: 4, maxBarThickness: 24, yAxisID: "y", order: 2, ...bar },
        { type: "line", order: 1, borderWidth: 2.5, pointRadius: 2.5, tension: 0.3, yAxisID: "y1", ...line },
      ],
    },
    options: o,
  });
}

// 막대·선 여러 개 (왼쪽 축: 막대, 오른쪽 축: 선) — 데이터셋마다 type 지정
export function multiCombo(canvas, labels, datasets, opts = {}) {
  const o = base(opts);
  o.scales.y1 = { position: "right", beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { font: { size: 11 }, color: "#c2410c", callback: (v) => short(v) } };
  return make(canvas, {
    type: "bar",
    data: { labels, datasets: datasets.map((d) => (d.type === "line" ? { order: 1, borderWidth: 2.5, pointRadius: 2.5, tension: 0.3, yAxisID: "y1", spanGaps: true, ...d } : { type: "bar", borderRadius: 4, maxBarThickness: 16, yAxisID: "y", order: 2, ...d })) },
    options: o,
  });
}

export const dayLabels = (days) => days.map(dayLabel);
