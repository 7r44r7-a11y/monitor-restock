// Monitor de restock Pokémon TCG 30 Anos (Continente, Note, Centroxogo).
// Uso: node monitor.js            -> corre em loop
//      node monitor.js --once     -> faz uma verificação e sai
//      node monitor.js --test     -> envia uma notificação de teste
//      node monitor.js --telegram -> configura o bot do Telegram

const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { spawn } = require("child_process");

const DIR = __dirname;
const CONFIG_FILE = path.join(DIR, "config.json");
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const STATE_FILE = path.join(DIR, "estado.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const log = (...a) => console.log(`[${new Date().toLocaleString("pt-PT")}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENTITIES = { quot: '"', amp: "&", apos: "'", lt: "<", gt: ">", nbsp: " " };
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&([a-z]+);/gi, (m, name) => {
      if (ENTITIES[name]) return ENTITIES[name];
      // &eacute; &ccedil; &atilde; ... -> letra acentuada
      const t = decodeAccent(name);
      return t ?? m;
    });
}
const ACCENTS = { acute: "́", grave: "̀", circ: "̂", tilde: "̃", uml: "̈", cedil: "̧" };
function decodeAccent(name) {
  const m = /^([a-z])(acute|grave|circ|tilde|uml|cedil)$/i.exec(name);
  return m ? (m[1] + ACCENTS[m[2]]).normalize("NFC") : null;
}

// "Pokémon-30-Anos" -> "pokemon 30 anos", para comparar nomes e URLs com as palavras-chave.
const normalize = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[-_]+/g, " ");
const KEYWORDS = CONFIG.palavrasChave.map(normalize);
const matches = (text) => KEYWORDS.some((k) => normalize(text).includes(k));

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "pt-PT,pt;q=0.9" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

// ---------- Sites ----------
// Cada site devolve uma lista de { id, nome, preco, emStock, url }.

const continente = {
  nome: "Continente",
  async produtos(cfg) {
    const found = new Map();
    for (const q of cfg.pesquisas) {
      const html = await get(`https://www.continente.pt/on/demandware.store/Sites-continente-Site/default/Search-UpdateGrid?cgid=col-produtos&q=${encodeURIComponent(q)}&srule=price-high-to-low&start=0&sz=200`);
      const re = /class="product-tile col-product-tile pid-(\d+) ([^"]*)"[\s\S]*?data-product-tile-impression='([^']*)'/g;
      let m;
      while ((m = re.exec(html))) {
        const [, id, classes, impression] = m;
        let info;
        try { info = JSON.parse(decode(impression)); } catch { continue; }
        if (!matches(info.name)) continue;
        const link = new RegExp(`href="(https://www\\.continente\\.pt/produto/[^"]*-${id}\\.html)"`).exec(html);
        found.set(id, {
          id,
          nome: info.name,
          preco: info.price,
          emStock: !classes.includes("out-of-stock"),
          url: link ? link[1] : `https://www.continente.pt/pesquisa/?q=${id}`,
        });
      }
    }
    return [...found.values()];
  },
};

// Note (Shopify): descobre os produtos pela pesquisa de vez em quando e verifica cada um pelo JSON da loja.
const note = {
  nome: "Note",
  handles: [],
  ultimaDescoberta: 0,
  async descobrir(cfg) {
    const handles = new Set();
    for (const q of cfg.pesquisas) {
      const vistos = new Set();
      // Ordenado do mais caro para o mais barato: as caixas TCG aparecem logo na 1.ª página.
      // A Note limita pedidos (HTTP 429), por isso fica-se pela primeira página.
      for (let page = 1; page <= 1; page++) {
        const html = await get(`https://noteonline.pt/search?q=${encodeURIComponent(q)}&type=product&sort_by=price-descending&page=${page}`);
        const novos = [...(html || "").matchAll(/href="\/products\/([^"?#]+)/g)].map((m) => m[1]).filter((h) => !vistos.has(h));
        if (!novos.length) break; // fim dos resultados
        novos.forEach((h) => vistos.add(h));
        novos.filter(matches).forEach((h) => handles.add(h));
        await sleep(3000);
      }
    }
    if (handles.size) this.handles = [...new Set([...this.handles, ...handles])];
    this.ultimaDescoberta = Date.now();
  },
  async produtos(cfg) {
    // Produtos conhecidos (config "produtos") são sempre verificados; a pesquisa só acrescenta novos.
    if (!this.handles.length) this.handles = [...(cfg.produtos || [])];
    if (!this.ultimaDescoberta || Date.now() - this.ultimaDescoberta > 3 * 60 * 60 * 1000) {
      this.ultimaDescoberta = Date.now();
      // Se a pesquisa falhar, continua com a lista anterior.
      try { await this.descobrir(cfg); } catch (e) { if (!this.handles.length) throw e; log("Note: pesquisa falhou, uso a lista anterior.", e.message); }
    }
    const out = [];
    for (const h of this.handles) {
      let json;
      try { json = await get(`https://noteonline.pt/products/${h}.js`); } catch (e) { log("Note:", e.message); await sleep(5000); continue; }
      if (!json) continue;
      const p = JSON.parse(json);
      out.push({ id: String(p.id), nome: p.title, preco: p.price / 100, emStock: p.available, url: `https://noteonline.pt/products/${h}` });
      await sleep(1000);
    }
    return out;
  },
};

// Centroxogo (Magento): a pesquisa do site bloqueia acessos automáticos, por isso os produtos
// são descobertos pelo sitemap público (1x por dia, é um ficheiro grande) e verificados página a página.
const centroxogo = {
  nome: "Centroxogo",
  urls: [],
  ultimaDescoberta: 0,
  async descobrir() {
    const index = await get("https://www.centroxogo.pt/sitemappt.xml");
    const urls = new Set();
    for (const [, sitemap] of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const xml = await get(sitemap);
      for (const [, loc] of (xml || "").matchAll(/<loc>([^<]+)<\/loc>/g)) {
        if (/pokemon/i.test(loc) && matches(loc)) urls.add(loc);
      }
    }
    if (urls.size) this.urls = [...urls];
    this.ultimaDescoberta = Date.now();
    log(`Centroxogo: ${this.urls.length} produtos encontrados no sitemap.`);
  },
  async produtos() {
    if (!this.urls.length || Date.now() - this.ultimaDescoberta > 24 * 60 * 60 * 1000) {
      try { await this.descobrir(); } catch (e) { if (!this.urls.length) throw e; log("Centroxogo: sitemap falhou, uso a lista anterior.", e.message); }
    }
    const out = [];
    for (const url of this.urls) {
      let html;
      try { html = await get(url); } catch (e) { log("Centroxogo:", e.message); continue; }
      await sleep(3000);
      if (!html) continue; // produto removido do site
      const meta = (prop) => (new RegExp(`property="${prop}" content="([^"]*)"`).exec(html) || [])[1];
      const disponibilidade = meta("product:availability");
      if (!disponibilidade) continue;
      out.push({
        id: url.replace(/^.*\/|\.html$/g, ""),
        nome: decode(meta("og:title") || url),
        preco: Number(meta("product:price:amount")) || "?",
        emStock: disponibilidade === "in stock",
        url,
      });
    }
    return out;
  },
};

const SITES = { continente, note, centroxogo };

// ---------- Notificações ----------

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function notifyWindows(title, body) {
  // Balão na área de notificação + som, sem dependências extra.
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Media.SystemSounds]::Exclamation.Play()
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(15000, $env:NOTIF_TITLE, $env:NOTIF_BODY, 'Info')
Start-Sleep -Seconds 16
$n.Dispose()`;
  spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], {
    env: { ...process.env, NOTIF_TITLE: title, NOTIF_BODY: body.slice(0, 250) },
    detached: true,
    stdio: "ignore",
  }).unref();
}

async function notifyTelegram(text) {
  // No GitHub Actions o token vem dos "secrets" (variáveis de ambiente), não do config.json.
  const botToken = process.env.TELEGRAM_BOT_TOKEN || CONFIG.telegram?.botToken;
  const chatId = process.env.TELEGRAM_CHAT_ID || CONFIG.telegram?.chatId;
  if (!botToken || !chatId) return;
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
  });
  if (!res.ok) log("Erro Telegram:", res.status, await res.text());
}

async function notify(products) {
  const title = products.length === 1 ? "RESTOCK Pokémon 30 Anos!" : `${products.length} RESTOCKS Pokémon 30 Anos!`;
  const lines = products.map((p) => `[${p.site}] ${p.nome} (${p.preco}€)\n${p.url}`);
  log(`*** ${title} ***\n` + lines.join("\n"));
  if (CONFIG.notificacaoWindows && process.platform === "win32") notifyWindows(title, products.map((p) => `[${p.site}] ${p.nome} - ${p.preco}€`).join("\n"));
  if (CONFIG.abrirNoBrowser && process.platform === "win32") for (const p of products) spawn("cmd", ["/c", "start", "", p.url], { detached: true, stdio: "ignore" }).unref();
  await notifyTelegram(`🔔 ${title}\n\n${lines.join("\n\n")}`);
}

// ---------- Verificação ----------

async function check() {
  const state = loadState();
  const restocked = [];
  const resumo = [];
  // Listas de produtos descobertas ficam guardadas no estado, para não repetir a descoberta
  // em cada execução (importante no GitHub Actions, onde cada verificação é um processo novo).
  state._cache = state._cache || {};

  for (const [key, site] of Object.entries(SITES)) {
    const cfg = CONFIG.sites[key];
    if (!cfg || !cfg.ativo) continue;
    if (!site.ultimaDescoberta && state._cache[key]) Object.assign(site, state._cache[key]);
    // Cada site pode ter o seu próprio intervalo, para não sobrecarregar as lojas mais pequenas.
    const intervalo = (cfg.intervaloMinutos || 0) * 60 * 1000;
    if (site.ultimaVerificacao && Date.now() - site.ultimaVerificacao < intervalo) continue;
    site.ultimaVerificacao = Date.now();
    let products;
    try {
      products = await site.produtos(cfg);
    } catch (e) {
      resumo.push(`  ${site.nome}: erro (${e.message})`);
      continue;
    } finally {
      if (site.ultimaDescoberta) {
        state._cache[key] = { ultimaDescoberta: site.ultimaDescoberta };
        if (site.handles) state._cache[key].handles = site.handles;
        if (site.urls) state._cache[key].urls = site.urls;
      }
    }
    if (!products.length) {
      resumo.push(`  ${site.nome}: nenhum produto encontrado (estado mantido)`);
      continue;
    }
    resumo.push(`  ${site.nome}:`);
    for (const p of products) {
      p.site = site.nome;
      const id = `${key}:${p.id}`;
      const before = state[id];
      // Notifica quando passa de esgotado para disponível, ou quando aparece um produto novo já disponível.
      if (p.emStock && (!before || !before.emStock)) restocked.push(p);
      state[id] = { nome: p.nome, emStock: p.emStock, url: p.url };
      resumo.push(`    ${p.emStock ? "✅ DISPONÍVEL" : "❌ esgotado  "}  ${p.nome}`);
    }
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log(`Verificação concluída:\n${resumo.join("\n")}`);
  if (restocked.length) await notify(restocked);
}

async function setupTelegram() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("Configuração do Telegram\n");
  console.log("1. No Telegram, abre o @BotFather, envia /newbot e segue os passos.");
  console.log("2. Copia o token que ele te dá (algo como 123456789:ABC-...).\n");
  const botToken = (await rl.question("Cola aqui o token do bot: ")).trim();

  const me = await (await fetch(`https://api.telegram.org/bot${botToken}/getMe`)).json();
  if (!me.ok) {
    console.log("Token inválido:", me.description);
    rl.close();
    return;
  }
  console.log(`\nBot encontrado: @${me.result.username}`);
  console.log(`3. Abre https://t.me/${me.result.username} no Telegram, carrega em "Start" e envia-lhe uma mensagem qualquer.`);
  await rl.question("Depois de enviares a mensagem, carrega Enter aqui...");
  rl.close();

  let chatId = null;
  for (let tentativa = 0; tentativa < 10 && !chatId; tentativa++) {
    const upd = await (await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`)).json();
    const msg = (upd.result || []).map((u) => u.message).filter(Boolean).pop();
    if (msg) chatId = String(msg.chat.id);
    else await sleep(3000);
  }
  if (!chatId) {
    console.log("Não recebi nenhuma mensagem no bot. Envia-lhe uma mensagem e corre isto outra vez.");
    return;
  }

  CONFIG.telegram = { botToken, chatId };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2) + "\n");
  console.log("\nGuardado no config.json. A enviar mensagem de teste...");
  await notifyTelegram("✅ Monitor de restock Pokémon 30 Anos ligado! Vais receber aqui os alertas.");
  console.log("Feito! Verifica o Telegram.");
}

async function main() {
  if (process.argv.includes("--telegram")) return setupTelegram();
  if (process.argv.includes("--test")) {
    await notify([{ site: "Teste", nome: "Teste de notificação", preco: 0, url: "https://www.continente.pt" }]);
    return;
  }
  const once = process.argv.includes("--once");
  const ativos = Object.keys(SITES).filter((k) => CONFIG.sites[k]?.ativo).map((k) => SITES[k].nome);
  log(`Monitor iniciado. Sites: ${ativos.join(", ")}. Palavras-chave: ${CONFIG.palavrasChave.join(", ")}. Intervalo: ${CONFIG.intervaloSegundos}s`);
  while (true) {
    try { await check(); } catch (e) { log("Erro na verificação:", e.message); }
    if (once) break;
    // Pequena variação aleatória para não pedir sempre ao mesmo segundo.
    await sleep(CONFIG.intervaloSegundos * 1000 * (0.85 + Math.random() * 0.3));
  }
}

main();
