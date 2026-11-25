/* app.js — modelo, interfaz y motor de simulación del simulador IBEX 35. */

(function () {
  "use strict";

  const FALLBACK = window.IBEX_FALLBACK;
  const DAYS = 5;

  const state = {
    budget: 15000,
    weights: {},
    broker: "bank",
    ftt: true,
    exitFee: true,
    paths: 10000,
    drift: "neutral",
    model: "gaussian",
    assets: [],
    index: null,
    mode: "loading",
    provider: "",
    updatedAt: "",
    asOf: "",
    sim: null,
    book: null,
    loading: false
  };

  /* ---------- Formato ---------- */

  const eur0 = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const eur2 = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num1 = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const num2 = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const int0 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });

  const money0 = v => eur0.format(v);
  const money2 = v => eur2.format(v);
  const signedMoney = v => (v > 0 ? "+" : v < 0 ? "−" : "±") + eur2.format(Math.abs(v));
  const pct2 = v => (v > 0 ? "+" : v < 0 ? "−" : "") + num2.format(Math.abs(v)) + " %";
  const pct1 = v => num1.format(v) + " %";
  const signClass = v => (v > 0 ? "pos" : v < 0 ? "neg" : "");

  const $ = sel => document.querySelector(sel);

  /* ---------- Utilidades estadísticas ---------- */

  function mean(arr) {
    let s = 0;
    for (let i = 0; i < arr.length; i += 1) s += arr[i];
    return s / arr.length;
  }

  function stdev(arr, m) {
    const mu = m === undefined ? mean(arr) : m;
    let s = 0;
    for (let i = 0; i < arr.length; i += 1) s += (arr[i] - mu) * (arr[i] - mu);
    return Math.sqrt(s / (arr.length - 1));
  }

  function quantileSorted(arr, q) {
    const pos = (arr.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    return arr[base + 1] !== undefined ? arr[base] + rest * (arr[base + 1] - arr[base]) : arr[base];
  }

  function normalPair() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const r = Math.sqrt(-2 * Math.log(u));
    return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
  }

  function quantiles(sorted, list) {
    const out = {};
    list.forEach(q => { out[q] = quantileSorted(sorted, q); });
    return out;
  }

  /* ---------- Datos y estadísticas ---------- */

  function buildAssets(dataset) {
    return dataset.assets.map(asset => {
      const prev = asset.prevClose || asset.price;
      return {
        ticker: asset.ticker,
        name: asset.name,
        short: asset.short || asset.name,
        sector: asset.sector || "",
        price: asset.price,
        prevClose: prev,
        changePercent: prev ? ((asset.price - prev) / prev) * 100 : 0,
        dates: dataset.dates.slice(),
        closes: asset.closes.slice(),
        source: "backup",
        marketTime: dataset.updatedAt
      };
    });
  }

  function applyLive(result) {
    let updated = 0;
    state.assets.forEach(asset => {
      const series = result.series.get(asset.ticker);
      if (!series) return;
      asset.price = series.price;
      asset.prevClose = series.prevClose;
      asset.changePercent = series.changePercent;
      asset.dates = series.dates;
      asset.closes = series.closes;
      asset.source = "live";
      asset.marketTime = series.marketTime;
      updated += 1;
    });

    const indexSeries = result.series.get("^IBEX");
    if (indexSeries) {
      state.index = {
        price: indexSeries.price,
        prevClose: indexSeries.prevClose,
        changePercent: indexSeries.changePercent
      };
    }

    return updated;
  }

  function alignedReturns() {
    const maps = state.assets.map(asset => {
      const map = new Map();
      for (let i = 1; i < asset.closes.length; i += 1) {
        const prev = asset.closes[i - 1];
        const cur = asset.closes[i];
        if (prev > 0 && cur > 0) map.set(asset.dates[i], Math.log(cur / prev));
      }
      return map;
    });

    let common = [...maps[0].keys()];
    for (let m = 1; m < maps.length; m += 1) {
      common = common.filter(date => maps[m].has(date));
    }
    common.sort();

    const rows = common.map(date => maps.map(map => map.get(date)));
    const columns = state.assets.map((asset, index) => rows.map(row => row[index]));
    return { dates: common, rows, columns };
  }

  function computeStats() {
    const { columns } = alignedReturns();
    const n = columns[0].length;
    const stats = columns.map(col => {
      const mu = mean(col);
      const sd = stdev(col, mu);
      return { mu, sd, weeklyVol: sd * Math.sqrt(DAYS), annualVol: sd * Math.sqrt(252) };
    });

    const corr = columns.map(a => columns.map(b => {
      const ma = mean(a);
      const mb = mean(b);
      let cov = 0;
      let va = 0;
      let vb = 0;
      for (let i = 0; i < a.length; i += 1) {
        const da = a[i] - ma;
        const db = b[i] - mb;
        cov += da * db;
        va += da * da;
        vb += db * db;
      }
      return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
    }));

    return { stats, corr, observations: n };
  }

  /* ---------- Asignación y costes ---------- */

  function brokerConfig() {
    return FALLBACK.brokers[state.broker];
  }

  function computeAllocation() {
    const totalWeight = state.assets.reduce((sum, a) => sum + Math.max(0, state.weights[a.ticker] || 0), 0);
    const broker = brokerConfig();
    const fttRate = state.ftt ? 0.002 : 0;

    const rows = state.assets.map(asset => {
      const weight = totalWeight > 0 ? Math.max(0, state.weights[asset.ticker] || 0) / totalWeight : 0;
      const target = state.budget * weight;
      let shares = asset.price > 0 ? Math.floor(target / asset.price) : 0;

      const totalFor = s => {
        if (s <= 0) return 0;
        const amount = s * asset.price;
        return amount + Math.max(broker.min, amount * broker.commission) + amount * fttRate;
      };

      while (shares > 0 && totalFor(shares) > target + 1e-9) shares -= 1;

      const amount = shares * asset.price;
      const commission = shares > 0 ? Math.max(broker.min, amount * broker.commission) : 0;
      const ftt = amount * fttRate;
      const total = amount + commission + ftt;

      return {
        asset,
        weight,
        target,
        shares,
        amount,
        commission,
        ftt,
        total
      };
    });

    const invested = rows.reduce((s, r) => s + r.amount, 0);
    const commissions = rows.reduce((s, r) => s + r.commission, 0);
    const fttTotal = rows.reduce((s, r) => s + r.ftt, 0);
    const spent = invested + commissions + fttTotal;
    const cash = Math.max(0, state.budget - spent);

    return { rows, invested, commissions, fttTotal, spent, cash, totalWeight };
  }

  /* ---------- Motor Monte Carlo ---------- */

  function cholesky(matrix) {
    const n = matrix.length;
    const out = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j <= i; j += 1) {
        let sum = matrix[i][j];
        for (let k = 0; k < j; k += 1) sum -= out[i][k] * out[j][k];
        if (i === j) out[i][j] = Math.sqrt(Math.max(sum, 1e-12));
        else out[i][j] = sum / out[j][j];
      }
    }
    return out;
  }

  function simulate(alloc, statsBundle) {
    const rows = alloc.rows.filter(r => r.shares > 0);
    if (!rows.length || alloc.invested <= 0) return null;

    const assets = state.assets;
    const weights = rows.map(r => r.amount / alloc.invested);
    const sdRow = rows.map(r => statsBundle.stats[assets.findIndex(a => a.ticker === r.asset.ticker)].sd);
    const covRows = rows.map((r, i) => rows.map((r2, j) => {
      const a = assets.findIndex(x => x.ticker === r.asset.ticker);
      const b = assets.findIndex(x => x.ticker === r2.asset.ticker);
      return statsBundle.corr[a][b] * sdRow[i] * sdRow[j];
    }));

    const L = cholesky(covRows);
    const n = rows.length;
    const paths = state.paths;

    const drift = rows.map((r, i) => {
      const a = assets.findIndex(x => x.ticker === r.asset.ticker);
      const s = statsBundle.stats[a];
      if (state.drift === "history") return Math.max(-0.004, Math.min(0.004, s.mu));
      if (state.drift === "momentum") {
        const closes = state.assets[a].closes;
        const look = 20;
        if (closes.length <= look) return 0;
        const m = Math.log(closes[closes.length - 1] / closes[closes.length - 1 - look]) / look;
        return Math.max(-0.005, Math.min(0.005, m));
      }
      return 0;
    });

    const aligned = alignedReturns();
    const T = aligned.rows.length;
    const bootstrap = state.model === "bootstrap" && T > DAYS + 1;

    const fan = Array.from({ length: DAYS + 1 }, () => new Float64Array(paths));
    for (let d = 0; d <= DAYS; d += 1) fan[d].fill(1);

    const terminal = new Float64Array(paths);
    const cum = new Float64Array(n);
    const normals = new Float64Array(n);

    for (let p = 0; p < paths; p += 1) {
      cum.fill(0);
      const start = bootstrap ? Math.floor(Math.random() * (T - DAYS)) : 0;

      for (let d = 0; d < DAYS; d += 1) {
        if (bootstrap) {
          const row = aligned.rows[start + d];
          for (let i = 0; i < n; i += 1) {
            const a = assets.findIndex(x => x.ticker === rows[i].asset.ticker);
            cum[i] += row[a];
          }
        } else {
          for (let i = 0; i < n; i += 1) normals[i] = normalPair()[0];
          for (let i = 0; i < n; i += 1) {
            let value = drift[i];
            for (let k = 0; k <= i; k += 1) value += L[i][k] * normals[k];
            cum[i] += value;
          }
        }

        let value = 0;
        for (let i = 0; i < n; i += 1) value += weights[i] * Math.exp(cum[i]);
        fan[d + 1][p] = value;
      }

      terminal[p] = fan[DAYS][p];
    }

    const exitRate = state.exitFee
      ? rows.reduce((sum, r) => sum + (r.shares * r.asset.price * brokerConfig().commission) / alloc.invested, 0)
      : 0;

    const netReturns = new Float64Array(paths);
    for (let p = 0; p < paths; p += 1) {
      const investedNow = alloc.invested * terminal[p] * (1 - exitRate);
      netReturns[p] = (alloc.cash + investedNow - state.budget) / state.budget;
    }

    const fanPercentiles = fan.map(values => {
      const sorted = Array.from(values).sort((a, b) => a - b);
      return {
        p5: quantileSorted(sorted, 0.05),
        p25: quantileSorted(sorted, 0.25),
        p50: quantileSorted(sorted, 0.5),
        p75: quantileSorted(sorted, 0.75),
        p95: quantileSorted(sorted, 0.95)
      };
    });

    const sortedNet = Array.from(netReturns).sort((a, b) => a - b);
    const stat = quantiles(sortedNet, [0.01, 0.05, 0.25, 0.5, 0.75, 0.95]);
    const probLoss = sortedNet.filter(v => v < 0).length / paths;

    return {
      fan: fanPercentiles,
      netReturns,
      sortedNet,
      q: stat,
      meanNet: mean(sortedNet),
      probLoss,
      exitRate,
      paths
    };
  }

  /* ---------- Gráficos ---------- */

  const palette = {};

  function readPalette() {
    const css = getComputedStyle(document.documentElement);
    palette.line = css.getPropertyValue("--line").trim() || "#242b35";
    palette.lineSoft = css.getPropertyValue("--line-soft").trim() || "#1a2028";
    palette.muted = css.getPropertyValue("--muted").trim() || "#9aa4b2";
    palette.dim = css.getPropertyValue("--dim").trim() || "#717c8c";
    palette.accent = css.getPropertyValue("--accent").trim() || "#f0b849";
    palette.pos = css.getPropertyValue("--pos").trim() || "#45d09a";
    palette.neg = css.getPropertyValue("--neg").trim() || "#ff6f6f";
    palette.text = css.getPropertyValue("--text").trim() || "#eef1f5";
  }

  function prepare(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.font = '10px "IBM Plex Mono", monospace';
    return { ctx, w: rect.width, h: rect.height };
  }

  function drawFan() {
    const canvas = $("#fan");
    const setup = prepare(canvas);
    if (!setup || !state.sim) return;
    const { ctx, w, h } = setup;
    const sim = state.sim;
    const pad = { l: 46, r: 14, t: 14, b: 26 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    const values = sim.fan.flatMap(f => [f.p5, f.p95, 1]);
    let min = Math.min(...values);
    let max = Math.max(...values);
    const span = Math.max(max - min, 0.02);
    min -= span * 0.12;
    max += span * 0.12;

    const x = d => pad.l + (d / DAYS) * plotW;
    const y = v => pad.t + ((max - v) / (max - min)) * plotH;

    ctx.lineWidth = 1;
    ctx.strokeStyle = palette.lineSoft;
    ctx.fillStyle = palette.dim;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let t = 0; t <= 4; t += 1) {
      const v = min + ((max - min) / 4) * t;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(w - pad.r, yy);
      ctx.stroke();
      ctx.fillText(((v - 1) * 100).toFixed(1) + " %", pad.l - 8, yy);
    }

    // Banda P5–P95
    ctx.beginPath();
    sim.fan.forEach((f, d) => (d === 0 ? ctx.moveTo(x(d), y(f.p95)) : ctx.lineTo(x(d), y(f.p95))));
    for (let d = sim.fan.length - 1; d >= 0; d -= 1) ctx.lineTo(x(d), y(sim.fan[d].p5));
    ctx.closePath();
    ctx.fillStyle = "rgba(240, 184, 73, 0.10)";
    ctx.fill();

    // Banda P25–P75
    ctx.beginPath();
    sim.fan.forEach((f, d) => (d === 0 ? ctx.moveTo(x(d), y(f.p75)) : ctx.lineTo(x(d), y(f.p75))));
    for (let d = sim.fan.length - 1; d >= 0; d -= 1) ctx.lineTo(x(d), y(sim.fan[d].p25));
    ctx.closePath();
    ctx.fillStyle = "rgba(240, 184, 73, 0.20)";
    ctx.fill();

    // Línea de capital inicial
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = palette.line;
    ctx.beginPath();
    ctx.moveTo(pad.l, y(1));
    ctx.lineTo(w - pad.r, y(1));
    ctx.stroke();
    ctx.restore();

    // Mediana
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    sim.fan.forEach((f, d) => (d === 0 ? ctx.moveTo(x(d), y(f.p50)) : ctx.lineTo(x(d), y(f.p50))));
    ctx.stroke();

    ctx.fillStyle = palette.accent;
    sim.fan.forEach((f, d) => {
      ctx.beginPath();
      ctx.arc(x(d), y(f.p50), d === DAYS ? 3 : 1.8, 0, Math.PI * 2);
      ctx.fill();
    });

    // Etiquetas X
    ctx.fillStyle = palette.dim;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labels = ["Hoy", "1", "2", "3", "4", "5"];
    for (let d = 0; d <= DAYS; d += 1) ctx.fillText(labels[d], x(d), h - pad.b + 8);

    // Etiqueta del valor final
    const last = sim.fan[DAYS].p50;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = palette.text;
    ctx.fillText(((last - 1) * 100).toFixed(1) + " %", w - pad.r, y(last) - 6);
  }

  function drawHist() {
    const canvas = $("#hist");
    const setup = prepare(canvas);
    if (!setup || !state.sim) return;
    const { ctx, w, h } = setup;
    const sim = state.sim;
    const pad = { l: 10, r: 10, t: 16, b: 24 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    const values = Array.from(sim.netReturns);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    if (max - min < 0.001) { max = min + 0.001; }
    const bins = 38;
    const counts = new Array(bins).fill(0);
    values.forEach(v => {
      const idx = Math.min(bins - 1, Math.floor(((v - min) / (max - min)) * bins));
      counts[idx] += 1;
    });
    const peak = Math.max(...counts);

    const x = i => pad.l + (i / bins) * plotW;
    const barW = plotW / bins;

    counts.forEach((count, i) => {
      const v0 = min + ((max - min) / bins) * i;
      const v1 = min + ((max - min) / bins) * (i + 1);
      const mid = (v0 + v1) / 2;
      const barH = (count / peak) * plotH;
      ctx.fillStyle = mid >= 0 ? "rgba(69, 208, 154, 0.55)" : "rgba(255, 111, 111, 0.55)";
      ctx.fillRect(x(i) + 0.5, pad.t + plotH - barH, Math.max(barW - 1, 1), barH);
    });

    // Línea de cero
    const zeroX = pad.l + ((0 - min) / (max - min)) * plotW;
    if (zeroX >= pad.l && zeroX <= pad.l + plotW) {
      ctx.strokeStyle = palette.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(zeroX, pad.t);
      ctx.lineTo(zeroX, pad.t + plotH);
      ctx.stroke();
    }

    // Mediana
    const medX = pad.l + ((sim.q[0.5] - min) / (max - min)) * plotW;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = palette.accent;
    ctx.beginPath();
    ctx.moveTo(medX, pad.t);
    ctx.lineTo(medX, pad.t + plotH);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = palette.dim;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText((min * 100).toFixed(1) + " %", pad.l, pad.t + plotH + 7);
    ctx.textAlign = "right";
    ctx.fillText((max * 100).toFixed(1) + " %", pad.l + plotW, pad.t + plotH + 7);

    ctx.fillStyle = palette.accent;
    ctx.textAlign = medX < w / 2 ? "left" : "right";
    ctx.textBaseline = "bottom";
    const labelX = medX < w / 2 ? medX + 5 : medX - 5;
    ctx.fillText("mediana " + (sim.q[0.5] * 100).toFixed(1) + " %", labelX, pad.t - 3);
  }

  function drawCharts() {
    drawFan();
    drawHist();
  }

  /* ---------- Render ---------- */

  function renderStatus() {
    const el = $("#status");
    const text = document.querySelector(".status-text");
    el.classList.remove("is-live", "is-fallback", "is-loading");

    if (state.loading && state.mode === "loading") {
      el.classList.add("is-loading");
      text.textContent = "Actualizando…";
      return;
    }
    if (state.mode === "live") {
      el.classList.add("is-live");
      text.textContent = "En vivo · " + shortProvider();
    } else if (state.mode === "partial") {
      el.classList.add("is-fallback");
      text.textContent = "Mixto · " + state.assets.filter(a => a.source === "live").length + "/4 en vivo";
    } else {
      el.classList.add("is-fallback");
      text.textContent = "Respaldo local";
    }
  }

  function shortProvider() {
    if (!state.provider) return "mercado";
    if (state.provider.indexOf("Yahoo") > -1) return "Yahoo Finance";
    return state.provider;
  }

  function renderTape() {
    const tape = $("#tape");
    const parts = state.assets.map(asset => {
      const code = asset.ticker.replace(".MC", "");
      return `<span class="tape-item" title="${asset.short}"><b>${code}</b><span class="px">${num2.format(asset.price)}</span><span class="${signClass(asset.changePercent)}">${pct2(asset.changePercent)}</span></span>`;
    });
    const index = state.index || FALLBACK.index;
    if (index) {
      const ix = index;
      parts.push(
        `<span class="tape-item tape-ix"><b>IBEX 35</b><span class="px">${int0.format(ix.price)}</span><span class="${signClass(ix.changePercent)}">${pct2(ix.changePercent)}</span></span>`
      );
    }
    tape.innerHTML = parts.join("");
  }

  function renderAsOf() {
    $("#asof-date").textContent = state.asOf || "—";
    $("#asof-time").textContent = state.updatedAt
      ? new Date(state.updatedAt).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
      : "—";
    $("#asof-source").textContent = state.mode === "live" ? shortProvider() : state.mode === "partial" ? "Parcial" : "data.js";
  }

  function renderBanner() {
    const banner = $("#banner");
    if (state.mode === "live") {
      banner.hidden = true;
      return;
    }
    if (state.mode === "loading") {
      banner.hidden = true;
      return;
    }
    const missing = state.assets.filter(a => a.source !== "live").map(a => a.short);
    banner.hidden = false;
    $("#banner-text").textContent = missing.length
      ? `Sin conexión con el proveedor para ${missing.join(", ")}. Se muestran los cierres de data.js del ${FALLBACK.asOf}.`
      : `No se pudo contactar con el proveedor de mercado. Se muestra la instantánea de data.js del ${FALLBACK.asOf}.`;
  }

  function renderKPIs(alloc) {
    const sim = state.sim;
    const cells = [];

    cells.push(kpi("Capital inicial", money0(state.budget), `Efectivo final: ${money2(alloc.cash)}`));
    const investedPct = state.budget ? (alloc.invested / state.budget) * 100 : 0;
    cells.push(kpi("Invertido", money0(alloc.invested), `${num1.format(investedPct)} % del capital · ${alloc.rows.reduce((s, r) => s + r.shares, 0)} acciones`));
    const roundTrip = alloc.commissions + alloc.fttTotal + (state.exitFee ? alloc.commissions : 0);
    const roundPct = alloc.invested ? (roundTrip / alloc.invested) * 100 : 0;
    cells.push(kpi("Costes ida y vuelta", money2(roundTrip), `${num2.format(roundPct)} % sobre invertido`));

    if (sim) {
      const medianValue = state.budget * (1 + sim.q[0.5]);
      cells.push(kpi("Mediana a 1 semana", signedMoney(medianValue - state.budget), `${pct2(sim.q[0.5] * 100)} · capital ${money0(medianValue)}`, signClass(sim.q[0.5])));
      cells.push(kpi("VaR 95 % · P5", signedMoney(state.budget * (1 + sim.q[0.05]) - state.budget), `${pct2(sim.q[0.05] * 100)} · ${money0(state.budget * (1 + sim.q[0.05]))}`, "neg"));
      cells.push(kpi("Prob. de pérdida", pct1(sim.probLoss * 100), "capital final < inicial", sim.probLoss > 0.5 ? "neg" : ""));
    } else {
      cells.push(kpi("Mediana a 1 semana", "—", "sin posiciones"));
      cells.push(kpi("VaR 95 % · P5", "—", "sin posiciones"));
      cells.push(kpi("Prob. de pérdida", "—", "sin posiciones"));
    }

    $("#kpis").innerHTML = cells.join("");
  }

  function kpi(label, value, sub, cls) {
    return `<div class="kpi">
      <span class="kpi-label">${label}</span>
      <span class="kpi-value ${cls || ""}">${value}</span>
      <span class="kpi-sub">${sub}</span>
    </div>`;
  }

  function buildAllocRows() {
    const list = $("#alloc-list");
    list.innerHTML = state.assets.map(asset => `
      <li class="alloc-row" data-ticker="${asset.ticker}">
        <div class="asset-name">
          <b>${asset.short}</b>
          <span>${asset.ticker} · ${asset.sector}</span>
        </div>
        <div class="asset-px">
          <span class="js-price">—</span> €
          <small class="js-chg">—</small>
          <span class="src js-src">respaldo</span>
        </div>
        <div class="weight-cell">
          <input type="range" min="0" max="100" step="1" value="25" style="--fill:25%"
            data-ticker="${asset.ticker}" aria-label="Peso de ${asset.short} en la cartera" />
          <span class="weight-val js-real">—</span>
        </div>
        <div class="money"><span class="js-amount">—</span><small class="js-target">—</small></div>
        <div class="shares js-shares">—</div>
      </li>`).join("");
  }

  function updateAlloc(alloc) {
    alloc.rows.forEach(row => {
      const li = document.querySelector(`.alloc-row[data-ticker="${row.asset.ticker}"]`);
      if (!li) return;
      const asset = row.asset;
      const input = li.querySelector('input[type="range"]');
      const weight = state.weights[asset.ticker] || 0;

      if (document.activeElement !== input) input.value = weight;
      input.style.setProperty("--fill", Math.min(100, weight) + "%");

      li.querySelector(".js-price").textContent = num2.format(asset.price);
      const chg = li.querySelector(".js-chg");
      chg.textContent = pct2(asset.changePercent);
      chg.className = "js-chg " + signClass(asset.changePercent);

      const src = li.querySelector(".js-src");
      src.textContent = asset.source === "live" ? "vivo" : "respaldo";
      src.className = "src js-src" + (asset.source === "live" ? " live" : "");

      li.querySelector(".js-real").textContent = num1.format(row.weight * 100) + " % real";
      li.querySelector(".js-amount").textContent = money0(row.amount);
      li.querySelector(".js-target").textContent = "obj. " + money0(row.target);
      li.querySelector(".js-shares").textContent = int0.format(row.shares);
    });

    $("#foot-invested").textContent = money2(alloc.invested);
    $("#foot-comm").textContent = money2(alloc.commissions);
    $("#foot-ftt").textContent = money2(alloc.fttTotal);
    $("#foot-cash").textContent = money2(alloc.cash);

    const roundTrip = alloc.commissions + alloc.fttTotal + (state.exitFee ? alloc.commissions : 0);
    $("#round-trip").textContent = alloc.invested
      ? `${money2(roundTrip)} (${num2.format((roundTrip / alloc.invested) * 100)} %)`
      : "—";
  }

  function renderCorr(statsBundle) {
    const names = state.assets.map(a => a.short.slice(0, 4).toUpperCase());
    let html = '<div class="corr-cell head"></div>';
    names.forEach(n => { html += `<div class="corr-cell head">${n}</div>`; });
    state.assets.forEach((asset, i) => {
      html += `<div class="corr-cell head">${names[i]}</div>`;
      state.assets.forEach((_, j) => {
        const v = statsBundle.corr[i][j];
        html += `<div class="corr-cell ${i === j ? "diag" : ""}">${i === j ? "—" : num2.format(v)}</div>`;
      });
    });
    $("#corr").innerHTML = html;
  }

  function renderScenarios() {
    const sim = state.sim;
    const tbody = $("#scenarios");
    if (!sim) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">Añade peso a algún valor para simular.</td></tr>';
      return;
    }
    const rows = [
      { q: 0.05, tag: "P5", label: "Bajista severo" },
      { q: 0.25, tag: "P25", label: "Bajista" },
      { q: 0.5, tag: "P50", label: "Central", mid: true },
      { q: 0.75, tag: "P75", label: "Alcista" },
      { q: 0.95, tag: "P95", label: "Alcista fuerte" }
    ];

    tbody.innerHTML = rows.map(row => {
      const ret = sim.q[row.q];
      const capital = state.budget * (1 + ret);
      const delta = capital - state.budget;
      return `<tr>
        <th scope="row"><span class="pill ${row.mid ? "mid" : ""}">${row.tag}</span>${row.label}</th>
        <td class="num">${money0(capital)}</td>
        <td class="num ${signClass(delta)}">${signedMoney(delta)}</td>
        <td class="num ${signClass(ret)}">${pct2(ret * 100)}</td>
      </tr>`;
    }).join("");
  }

  function renderHistStats() {
    const sim = state.sim;
    const box = $("#hist-stats");
    if (!sim) { box.innerHTML = ""; return; }
    box.innerHTML = `
      <div><span>Ganancia probable</span><strong>${pct1((1 - sim.probLoss) * 100)}</strong></div>
      <div><span>Media</span><strong class="${signClass(sim.meanNet)}">${pct2(sim.meanNet * 100)}</strong></div>
      <div><span>Cola P1</span><strong class="neg">${pct2(sim.q[0.01] * 100)}</strong></div>
    `;
  }

  function renderOrders(alloc) {
    const tbody = $("#orders");
    tbody.innerHTML = alloc.rows.map(row => `
      <tr class="${row.shares === 0 ? "is-zero" : ""}">
        <th scope="row">${row.asset.short}</th>
        <td class="num">${int0.format(row.shares)}</td>
        <td class="num">${num2.format(row.asset.price)}</td>
        <td class="num">${money2(row.amount)}</td>
        <td class="num">${money2(row.commission + row.ftt)}</td>
        <td class="num">${money2(row.total)}</td>
      </tr>`).join("");

    $("#ord-amount").textContent = money2(alloc.invested);
    $("#ord-cost").textContent = money2(alloc.commissions + alloc.fttTotal);
    $("#ord-total").textContent = money2(alloc.spent);
    $("#execute").disabled = alloc.invested <= 0;
  }

  function resetToFallback() {
    state.index = null;
    state.assets = buildAssets(FALLBACK);
    state.assets.forEach(asset => { if (state.weights[asset.ticker] === undefined) state.weights[asset.ticker] = 25; });
  }

  function renderBook() {
    const body = $("#book-body");
    const reset = $("#reset-book");

    if (!state.book) {
      reset.hidden = true;
      body.innerHTML = '<div class="empty"><strong>Sin cartera ejecutada</strong>Pulsa «Ejecutar plan» para comprar la asignación actual a los precios de mercado mostrados.</div>';
      return;
    }

    const book = state.book;
    reset.hidden = false;
    const positions = book.positions.map(pos => {
      const asset = state.assets.find(a => a.ticker === pos.ticker);
      const value = asset.price * pos.shares;
      const pnl = value - pos.cost;
      return { ...pos, asset, value, pnl };
    });
    const value = positions.reduce((s, p) => s + p.value, 0);
    const pnl = positions.reduce((s, p) => s + p.pnl, 0);
    const total = book.cash + value;
    const ret = ((total - book.capital) / book.capital) * 100;

    body.innerHTML = `
      <div class="book-summary">
        <div><span>Capital</span><strong>${money2(book.capital)}</strong></div>
        <div><span>Efectivo</span><strong>${money2(book.cash)}</strong></div>
        <div><span>Valor de mercado</span><strong>${money2(total)}</strong></div>
        <div><span>Resultado</span><strong class="${signClass(pnl)}">${signedMoney(pnl)} · ${pct2(ret)}</strong></div>
      </div>
      <div class="table-scroll">
      <table class="table">
        <thead>
          <tr><th scope="col">Valor</th><th scope="col" class="num">Acciones</th><th scope="col" class="num">Entrada</th><th scope="col" class="num">Actual</th><th scope="col" class="num">Valor</th><th scope="col" class="num">Resultado</th></tr>
        </thead>
        <tbody>
          ${positions.map(p => `
            <tr>
              <th scope="row">${p.asset.short}</th>
              <td class="num">${int0.format(p.shares)}</td>
              <td class="num">${num2.format(p.entry)}</td>
              <td class="num">${num2.format(p.asset.price)}</td>
              <td class="num">${money2(p.value)}</td>
              <td class="num ${signClass(p.pnl)}">${signedMoney(p.pnl)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      </div>
      <p class="caption">Ejecutado el ${new Date(book.executedAt).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · costes pagados ${money2(book.fees)} · el resultado excluye la comisión de venta pendiente.</p>
    `;
  }

  /* ---------- Orquestación ---------- */

  function recalc() {
    const alloc = computeAllocation();
    const statsBundle = computeStats();
    state.sim = simulate(alloc, statsBundle);

    renderTape();
    renderKPIs(alloc);
    updateAlloc(alloc);
    renderCorr(statsBundle);
    renderScenarios();
    renderHistStats();
    renderOrders(alloc);
    renderBook();
    drawCharts();
  }

  let recalcTimer = null;
  function recalcSoon() {
    clearTimeout(recalcTimer);
    recalcTimer = setTimeout(recalc, 120);
  }

  function setMode(mode) {
    state.mode = mode;
    renderStatus();
    renderAsOf();
    renderBanner();
  }

  async function loadMarket(userInitiated) {
    if (state.loading) return;
    state.loading = true;
    if (state.mode === "loading") renderStatus();
    $("#refresh").classList.add("is-spinning");

    try {
      const symbols = FALLBACK.assets.map(a => a.yahoo || a.ticker);
      const result = await window.IBEXLive.loadMarket(symbols.concat(["^IBEX"]));

      if (result.ok) {
        const updated = applyLive(result);
        const liveCount = state.assets.filter(a => a.source === "live").length;

        if (liveCount === 0) {
          // Solo llegó el índice: seguimos en respaldo para la cartera.
          resetToFallback();
          state.provider = "";
          state.updatedAt = FALLBACK.updatedAt;
          state.asOf = FALLBACK.asOf;
          setMode("fallback");
          recalc();
          return;
        }

        state.provider = result.provider;
        state.updatedAt = new Date().toISOString();
        state.asOf = latestDate();
        setMode(liveCount === state.assets.length ? "live" : "partial");
        if (state.book) refreshBookMarks();
        recalc();
      } else {
        resetToFallback();
        state.provider = "";
        state.updatedAt = FALLBACK.updatedAt;
        state.asOf = FALLBACK.asOf;
        setMode("fallback");
        if (userInitiated) recalc();
      }
    } catch (error) {
      state.updatedAt = FALLBACK.updatedAt;
      state.asOf = FALLBACK.asOf;
      setMode("fallback");
    } finally {
      state.loading = false;
      $("#refresh").classList.remove("is-spinning");
      renderStatus();
    }
  }

  function latestDate() {
    let latest = "";
    state.assets.forEach(asset => {
      if (asset.source !== "live") return;
      const d = asset.dates[asset.dates.length - 1];
      if (d > latest) latest = d;
    });
    return latest || FALLBACK.asOf;
  }

  function refreshBookMarks() {
    if (!state.book) return;
    state.book.value = null;
  }

  /* ---------- Eventos ---------- */

  function bind() {
    $("#alloc-list").addEventListener("input", event => {
      const input = event.target.closest('input[type="range"]');
      if (!input) return;
      state.weights[input.dataset.ticker] = Number(input.value);
      input.style.setProperty("--fill", Number(input.value) + "%");
      document.querySelectorAll(".chip[data-preset]").forEach(c => c.classList.remove("is-active"));
      recalcSoon();
    });

    document.querySelectorAll(".chip[data-preset]").forEach(chip => {
      chip.addEventListener("click", () => {
        const presets = {
          equal: { "SAN.MC": 25, "BBVA.MC": 25, "TEF.MC": 25, "IAG.MC": 25 },
          banks: { "SAN.MC": 35, "BBVA.MC": 35, "TEF.MC": 10, "IAG.MC": 20 },
          defensive: { "SAN.MC": 25, "BBVA.MC": 20, "TEF.MC": 40, "IAG.MC": 15 }
        };
        state.weights = { ...presets[chip.dataset.preset] };
        document.querySelectorAll(".chip[data-preset]").forEach(c => c.classList.toggle("is-active", c === chip));
        recalc();
      });
    });

    $("#budget").addEventListener("change", event => {
      const value = Number(event.target.value);
      if (Number.isFinite(value) && value >= 1000) {
        state.budget = value;
        recalc();
      }
    });

    $("#broker").addEventListener("change", event => {
      state.broker = event.target.value;
      recalc();
    });

    $("#paths").addEventListener("change", event => {
      state.paths = Number(event.target.value);
      recalc();
    });

    $("#drift").addEventListener("change", event => {
      state.drift = event.target.value;
      recalc();
    });

    $("#model").addEventListener("change", event => {
      state.model = event.target.value;
      recalc();
    });

    $("#ftt").addEventListener("change", event => {
      state.ftt = event.target.checked;
      recalc();
    });

    $("#exit-fee").addEventListener("change", event => {
      state.exitFee = event.target.checked;
      recalc();
    });

    $("#refresh").addEventListener("click", () => loadMarket(true));
    $("#banner-retry").addEventListener("click", () => loadMarket(true));

    $("#execute").addEventListener("click", () => {
      const alloc = computeAllocation();
      const positions = alloc.rows.filter(r => r.shares > 0).map(r => ({
        ticker: r.asset.ticker,
        shares: r.shares,
        entry: r.asset.price,
        cost: r.amount
      }));
      if (!positions.length) return;
      state.book = {
        capital: state.budget,
        cash: alloc.cash,
        fees: alloc.commissions + alloc.fttTotal,
        positions,
        executedAt: new Date().toISOString()
      };
      renderBook();
      $("#book-body").scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    $("#reset-book").addEventListener("click", () => {
      state.book = null;
      renderBook();
    });

    window.addEventListener("resize", () => {
      clearTimeout(window.__chartTimer);
      window.__chartTimer = setTimeout(drawCharts, 120);
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.mode !== "live") loadMarket(false);
    });
  }

  /* ---------- Arranque ---------- */

  function init() {
    readPalette();
    state.assets = buildAssets(FALLBACK);
    state.assets.forEach(asset => { state.weights[asset.ticker] = 25; });
    state.updatedAt = FALLBACK.updatedAt;
    state.asOf = FALLBACK.asOf;
    state.mode = "loading";

    bind();
    buildAllocRows();
    recalc();
    renderStatus();
    renderAsOf();
    renderTape();

    // Primera carga en vivo; data.js ya está pintado como respaldo.
    loadMarket(false);

    // Reintento suave cada 5 minutos si seguimos sin datos en vivo.
    setInterval(() => {
      if (document.hidden) return;
      if (state.mode !== "live") loadMarket(false);
    }, 5 * 60 * 1000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
