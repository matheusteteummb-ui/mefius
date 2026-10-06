// Busca rendimentos e quantidade de cotas de todos os FIIs negociados na B3
// e grava dados-fii.json. Roda todo dia pelo GitHub Actions; também roda local com: node scripts/atualizar-dados.mjs
//
// Fontes:
//  - Lista de fundos: Dados Abertos da CVM (informe mensal de FII)
//  - Rendimentos e cotas: site da B3 (mesmos dados da página de cada fundo em b3.com.br)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dados-fii.json');
const B3_URL = 'https://sistemaswebb3-listados.b3.com.br/fundsProxy/fundsCall/GetListedSupplementFunds/';
// Fundos do relatório entram sempre, mesmo se a lista da CVM falhar
const SEMPRE = ['XPML', 'HSML', 'VISC', 'HGLG', 'BTLG', 'BRCO', 'LVBI', 'KNRI', 'HGRU', 'ALZR'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
const dataBR = s => { const [d, m, a] = String(s).split('/'); return Date.UTC(+a, +m - 1, +d); };

async function codigosDaCVM() {
  const ano = new Date().getFullYear();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvm-'));
  for (const a of [ano, ano - 1]) {
    const res = await fetch(`https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS/inf_mensal_fii_${a}.zip`);
    if (!res.ok) continue;
    const zip = path.join(tmp, 'inf.zip');
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    execFileSync('unzip', ['-o', '-q', zip, '-d', tmp]);
    const csv = fs.readdirSync(tmp).find(f => /inf_mensal_fii_geral_\d+\.csv$/.test(f));
    if (!csv) continue;
    const linhas = new TextDecoder('latin1').decode(fs.readFileSync(path.join(tmp, csv))).trim().split(/\r?\n/);
    const cab = linhas.shift().split(';');
    const iIsin = cab.indexOf('Codigo_ISIN');
    const iBolsa = cab.indexOf('Mercado_Negociacao_Bolsa');
    const cods = new Set();
    for (const l of linhas) {
      const v = l.split(';');
      const isin = v[iIsin] || '';
      if (v[iBolsa] === 'S' && /^BR[A-Z]{4}CTF/.test(isin)) cods.add(isin.slice(2, 6));
    }
    if (cods.size) return cods;
  }
  return new Set();
}

async function buscarB3(codigo) {
  const payload = Buffer.from(JSON.stringify({ cnpj: '0', identifierFund: codigo, typeFund: 7 })).toString('base64');
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const res = await fetch(B3_URL + payload, { headers: { 'User-Agent': 'Mozilla/5.0 (mefius-investimentos)' } });
      if (res.ok) return await res.json();
    } catch {}
    await sleep(1000);
  }
  return null;
}

function resumir(codigo, d, agora) {
  const cotas = num(d.quantity);
  if (!(cotas > 0)) return null;
  // Só a cota principal (ISIN com CTF): recibos de subscrição têm rendimentos próprios
  const vistos = new Set();
  const pagos = (d.cashDividends || [])
    .filter(x => /CTF/.test(x.isinCode || '') && /RENDIMENTO/i.test(x.label || ''))
    .map(x => ({ com: dataBR(x.lastDatePrior), valor: num(x.rate) }))
    .filter(x => x.valor > 0 && x.com <= agora && x.com > agora - 365 * 864e5)
    .filter(x => { const k = x.com + '|' + x.valor; if (vistos.has(k)) return false; vistos.add(k); return true; })
    .sort((a, b) => b.com - a.com)
    .slice(0, 12);
  const rend12 = pagos.reduce((s, x) => s + x.valor, 0);
  return {
    nome: String(d.fund || '').trim(),
    cotas,
    rend12: pagos.length ? Math.round(rend12 * 1e6) / 1e6 : null,
    pagamentos: pagos.length,
    ultimo: pagos.length ? pagos[0].valor : null,
    ultimaDataCom: pagos.length ? new Date(pagos[0].com).toISOString().slice(0, 10) : null,
  };
}

const agora = Date.now();
const codigos = await codigosDaCVM();
SEMPRE.forEach(c => codigos.add(c));
console.log(`Fundos para consultar: ${codigos.size}`);

const fundos = {};
const fila = [...codigos].sort();
let falhas = 0;
async function trabalhador() {
  while (fila.length) {
    const c = fila.shift();
    const d = await buscarB3(c);
    if (!d) { falhas++; continue; }
    const r = d.code ? resumir(c, d, agora) : null;
    if (r) fundos[`${String(d.code).trim()}11`] = r;
    await sleep(120);
  }
}
await Promise.all([1, 2, 3, 4].map(trabalhador));

const total = Object.keys(fundos).length;
console.log(`Fundos com dados: ${total} (sem resposta da B3: ${falhas}, em geral fundos encerrados ou com outro código)`);
if (total < 50) {
  console.error('Poucos fundos retornados; mantendo o arquivo anterior.');
  process.exit(1);
}

const ordenado = Object.fromEntries(Object.keys(fundos).sort().map(k => [k, fundos[k]]));
fs.writeFileSync(OUT, JSON.stringify({
  atualizadoEm: new Date(agora).toISOString(),
  fonte: 'B3 (rendimentos e cotas) e CVM (lista de fundos)',
  total,
  fundos: ordenado,
}));
console.log(`Gravado em ${OUT}`);
