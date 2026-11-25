/* live.js — cotizaciones e histórico en vivo.
   Estrategia: Yahoo Finance (gráfico diario, sin clave) a través de varios caminos,
   con timeout por intento. Si todos fallan, la app conserva data.js. */

window.IBEX_LIVE_CONFIG = {
  // Proxy propio opcional, p. ej. "https://mi-worker.dev/?url={url}".
  // Se prueba primero si está definido.
  proxy: "",
  timeoutMs: 9000,
  range: "6mo",
  interval: "1d"
};

(function () {
  const cfg = window.IBEX_LIVE_CONFIG;

  function chartUrl(symbol) {
    return (
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?range=" + cfg.range +
      "&interval=" + cfg.interval +
      "&includePrePost=false&events=div%2Csplits"
    );
  }

  function stripPreamble(text) {
    const jsonStart = text.indexOf('{"chart"');
    if (jsonStart > -1) return text.slice(jsonStart);
    const brace = text.indexOf("{");
    return brace > -1 ? text.slice(brace) : text;
  }

  const SOURCES = [
    {
      name: "Yahoo Finance",
      wrap: url => url,
      parse: text => JSON.parse(stripPreamble(text))
    },
    {
      name: "Yahoo · proxy de lectura",
      wrap: url => "https://r.jina.ai/" + url,
      parse: text => JSON.parse(stripPreamble(text))
    },
    {
      name: "Yahoo · AllOrigins",
      wrap: url => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
      parse: text => JSON.parse(stripPreamble(text))
    },
    {
      name: "Yahoo · CodeTabs",
      wrap: url => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url),
      parse: text => JSON.parse(stripPreamble(text))
    }
  ];

  function sourceList() {
    const list = SOURCES.slice();
    if (cfg.proxy) {
      list.unshift({
        name: "Proxy configurado",
        wrap: url => cfg.proxy.replace("{url}", encodeURIComponent(url)),
        parse: text => JSON.parse(stripPreamble(text))
      });
    }
    return list;
  }

  async function fetchText(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: "no-store",
        headers: { Accept: "application/json,text/plain,*/*" }
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  function toISODate(seconds) {
    return new Date(seconds * 1000).toISOString().slice(0, 10);
  }

  function parseChart(payload, symbol) {
    const result = payload && payload.chart && payload.chart.result && payload.chart.result[0];
    if (!result || !result.timestamp || !result.indicators || !result.indicators.quote) {
      throw new Error("respuesta sin series");
    }

    const quote = result.indicators.quote[0];
    const closes = quote.close || [];
    const dates = [];
    const values = [];

    for (let i = 0; i < result.timestamp.length; i += 1) {
      const value = closes[i];
      if (typeof value === "number" && isFinite(value)) {
        dates.push(toISODate(result.timestamp[i]));
        values.push(value);
      }
    }

    if (values.length < 30) throw new Error("histórico insuficiente");

    const meta = result.meta || {};
    const last = values[values.length - 1];
    const price = typeof meta.regularMarketPrice === "number" ? meta.regularMarketPrice : last;

    // Variación de la sesión: previousClose es el cierre del día anterior.
    // chartPreviousClose corresponde al cierre previo al inicio del rango (6 meses),
    // así que solo se usa como último recurso.
    const candidates = [meta.previousClose, values.length > 1 ? values[values.length - 2] : null, meta.chartPreviousClose];
    let prevClose = null;
    for (const candidate of candidates) {
      if (typeof candidate === "number" && isFinite(candidate) && candidate > 0) { prevClose = candidate; break; }
    }
    if (prevClose === null) prevClose = price;
    const change = price - prevClose;

    return {
      ticker: meta.symbol || symbol,
      price,
      prevClose,
      change,
      changePercent: prevClose ? (change / prevClose) * 100 : 0,
      currency: meta.currency || "EUR",
      marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
      dates,
      closes: values
    };
  }

  async function loadSymbol(symbol) {
    const url = chartUrl(symbol);
    const errors = [];

    for (const source of sourceList()) {
      try {
        const text = await fetchText(source.wrap(url), cfg.timeoutMs);
        const payload = source.parse(text);
        const data = parseChart(payload, symbol);
        data.provider = source.name;
        return { ok: true, data };
      } catch (error) {
        errors.push(source.name + ": " + (error && error.message ? error.message : "error"));
      }
    }

    return { ok: false, symbol, errors };
  }

  async function loadMarket(symbols) {
    const started = Date.now();
    const results = await Promise.all(symbols.map(loadSymbol));
    const ok = results.filter(r => r.ok);
    const providers = [...new Set(ok.map(r => r.data.provider))];

    return {
      ok: ok.length > 0,
      full: ok.length === symbols.length,
      count: ok.length,
      total: symbols.length,
      provider: providers.join(" · "),
      elapsedMs: Date.now() - started,
      series: new Map(ok.map(r => [r.data.ticker, r.data])),
      failures: results.filter(r => !r.ok).map(r => ({ symbol: r.symbol, errors: r.errors }))
    };
  }

  window.IBEXLive = { loadMarket };
})();
