/* ============================================================================
   dossie-parsers.js — extração de conteúdo/identificadores de arquivos de
   trabalho (CLP, SCADA, relatório PDF, tags, planilha, Python, QET, etc.) e
   cruzamento determinístico entre eles (buildCrossReferenceText).

   Usado por Avaliador.html (professor) e enviartrabalho.html (aluno) — é a
   ÚNICA implementação dessa lógica: qualquer correção/melhoria feita aqui
   vale pros dois automaticamente, sem precisar lembrar de replicar em dois
   lugares (foi assim que o cruzamento sumiu do lado do aluno da primeira
   vez).

   Depende de, já carregados na página ANTES deste script:
     - JSZip (https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js)
     - pdf.js (https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js)
       + pdfjsLib.GlobalWorkerOptions.workerSrc configurado pela página host.

   Não depende de nada específico de Avaliador.html/enviartrabalho.html
   (nenhum "state" global, nenhuma chamada de backend) — só File API, Canvas,
   JSZip e pdf.js. Pode ser incluído em qualquer página nova sem adaptação.

   VERSIONAMENTO: este arquivo é servido com caminho versionado
   (dossie-parsers.v1.js). Ao publicar uma mudança testada, crie
   dossie-parsers.v2.js (não sobrescreva o v1) e só então atualize o
   <script src> nos HTMLs que o usam — nunca aponte pra um arquivo que pode
   mudar sem aviso.
   ============================================================================ */

/* ==========================================================================
   PARSER — PROGRAMA CLP (.smbp — EcoStruxure Machine Expert Basic)
   ========================================================================== */
function dChild(el, tag){
  if (!el) return null;
  return Array.from(el.children).find(c => c.tagName === tag) || null;
}
function dText(el, tag, fallback=''){
  const c = dChild(el, tag);
  return c ? c.textContent.trim() : fallback;
}

function parseSMBP(xmlText, fileName){
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const perr = doc.querySelector('parsererror');
  if (perr) return { ok:false, error: 'XML do .smbp inválido ou corrompido (' + fileName + ')', summaryText:'' };

  const root = doc.documentElement;
  const projectName = dText(root, 'Name') || fileName;
  const swConfig = dChild(root, 'SoftwareConfiguration');
  const pousRoot = swConfig ? dChild(swConfig, 'Pous') : null;

  const ladderPOUs = [];
  let grafcet = null;

  if (pousRoot){
    Array.from(pousRoot.children).forEach(child => {
      if (child.tagName === 'ProgramOrganizationUnits'){
        const name = dText(child, 'Name');
        const rungs = child.querySelectorAll('RungEntity').length;
        const typeCounts = {};
        child.querySelectorAll('ElementType').forEach(el => {
          const t = el.textContent.trim();
          typeCounts[t] = (typeCounts[t]||0) + 1;
        });
        ladderPOUs.push({ name, rungs, typeCounts });
      } else if (child.tagName === 'GrafcetPou'){
        const steps = Array.from(child.querySelectorAll('GrafcetNodeStep')).map(s => {
          const sp = dChild(s, 'StepPou');
          return {
            stepNumber: dText(sp, 'StepNumber'),
            name: dText(sp, 'Name'),
            initial: dText(s, 'IsInitialStep') === 'true',
            rungsInStep: sp ? sp.querySelectorAll('RungEntity').length : 0
          };
        }).sort((a,b) => Number(a.stepNumber) - Number(b.stepNumber));
        const transitions = child.querySelectorAll('GrafcetTransition').length;
        grafcet = { steps, transitions };
      }
    });
  }

  const symbols = Array.from(doc.querySelectorAll('CustomSymbols > CustomSymbol')).map(cs => ({
    address: dText(cs, 'Address'), symbol: dText(cs, 'Symbol')
  }));

  const watchLists = Array.from(doc.querySelectorAll('WatchLists > WatchListEntity')).map(wl => {
    const items = Array.from(wl.querySelectorAll('WatchListItemEntity')).map(it => ({
      address: dText(it, 'Address'), traced: dText(it, 'IsTraced') === 'true'
    }));
    return { name: dText(wl, 'Name'), items, tracedCount: items.filter(i=>i.traced).length };
  });

  const digitalInputs = doc.querySelectorAll('DigitalInputs > DiscretInput').length;
  const digitalOutputs = doc.querySelectorAll('DigitalOutputs > DiscretOutput').length;
  const analogInputs = Array.from(doc.querySelectorAll('AnalogInputs > AnalogIO')).map(a => ({
    address: dText(a,'Address'), min: dText(a,'Minimum'), max: dText(a,'Maximum')
  }));
  const analogOutputs = Array.from(doc.querySelectorAll('AnalogOutputs > AnalogIO')).map(a => ({
    address: dText(a,'Address'), min: dText(a,'Minimum'), max: dText(a,'Maximum')
  }));

  const allTypeCounts = {};
  doc.querySelectorAll('ElementType').forEach(el => {
    const t = el.textContent.trim();
    allTypeCounts[t] = (allTypeCounts[t]||0) + 1;
  });

  // ----- Monta texto-resumo (para IA e para exibição) -----
  const lines = [];
  lines.push(`Arquivo: ${fileName}  |  Projeto: ${projectName}`);
  lines.push('');
  lines.push('POUs LADDER:');
  if (ladderPOUs.length === 0) lines.push('  (nenhum POU ladder encontrado)');
  ladderPOUs.forEach(p => {
    const types = Object.entries(p.typeCounts).map(([k,v]) => `${k}:${v}`).join(', ');
    lines.push(`  - "${p.name}" — ${p.rungs} rungs (instruções: ${types || 'nenhuma'})`);
  });
  lines.push('');
  lines.push('GRAFCET:');
  if (grafcet){
    lines.push(`  ${grafcet.steps.length} etapas, ${grafcet.transitions} transições`);
    grafcet.steps.forEach(s => lines.push(`  - Etapa ${s.stepNumber}${s.initial?' (inicial)':''}: "${s.name}" (${s.rungsInStep} rung(s) de ação)`));
  } else {
    lines.push('  (nenhum Grafcet encontrado no projeto)');
  }
  lines.push('');
  lines.push(`SÍMBOLOS CUSTOMIZADOS (${symbols.length}):`);
  symbols.forEach(s => lines.push(`  - ${s.symbol} = ${s.address}`));
  lines.push('');
  lines.push('TABELAS DE ANIMAÇÃO / GRÁFICO DE TEMPO (WatchLists):');
  if (watchLists.length === 0){
    lines.push('  (nenhuma tabela de animação encontrada — logo, nenhum gráfico de tempo configurado)');
  }
  watchLists.forEach(wl => {
    lines.push(`  - "${wl.name}": ${wl.items.length} variável(is) monitorada(s), ${wl.tracedCount} com traço/gráfico de tempo habilitado (IsTraced=true)`);
    lines.push(`      endereços: ${wl.items.map(i => i.address + (i.traced?'[TRAÇO ATIVO]':'')).join(', ')}`);
  });
  lines.push('');
  lines.push(`E/S DIGITAIS CONFIGURADAS: ${digitalInputs} entradas, ${digitalOutputs} saídas`);
  lines.push(`E/S ANALÓGICAS: ${analogInputs.length} entrada(s) [${analogInputs.map(a=>`${a.address}(${a.min}-${a.max})`).join(', ')}], ${analogOutputs.length} saída(s) [${analogOutputs.map(a=>`${a.address}(${a.min}-${a.max})`).join(', ')}]`);
  lines.push('');
  lines.push('CONTAGEM TOTAL DE INSTRUÇÕES LADDER POR TIPO: ' + Object.entries(allTypeCounts).map(([k,v])=>`${k}:${v}`).join(', '));

  return {
    ok:true,
    summaryText: lines.join('\n'),
    raw: { projectName, ladderPOUs, grafcet, symbols, watchLists, digitalInputs, digitalOutputs, analogInputs, analogOutputs }
  };
}

/* ==========================================================================
   PARSER — SCADA (Ignition Perspective, .zip)
   ========================================================================== */
function walkPerspectiveComponent(node, acc){
  if (!node || typeof node !== 'object') return;
  if (node.type){
    acc.typeCounts[node.type] = (acc.typeCounts[node.type]||0) + 1;
    const name = node.meta?.name || '';
    if (/alarm/i.test(node.type) || /alarme/i.test(name)) acc.alarmComponents.push(name || node.type);
    if (/chart|trend|power/i.test(node.type) || /histor/i.test(name)) acc.trendComponents.push(name || node.type);
  }
  // bindings (tag paths)
  const propConfig = node.propConfig;
  if (propConfig && typeof propConfig === 'object'){
    Object.values(propConfig).forEach(pc => {
      const tp = pc?.binding?.config?.tagPath;
      if (tp) acc.tagBindings.add(tp);
    });
  }
  // scripts em eventos
  if (node.events?.dom){
    Object.entries(node.events.dom).forEach(([evtName, evt]) => {
      const script = evt?.config?.script;
      if (script) acc.scripts.push({ component: node.meta?.name || node.type || '?', event: evtName, script: script.trim().slice(0,300) });
    });
  }
  if (Array.isArray(node.children)) node.children.forEach(c => walkPerspectiveComponent(c, acc));
}

async function parsePerspectiveZip(arrayBuffer, fileName){
  let zip;
  try{
    zip = await JSZip.loadAsync(arrayBuffer);
  }catch(e){
    return { ok:false, error:'Não consegui abrir "'+fileName+'" como .zip: ' + e.message, summaryText:'' };
  }

  const viewFiles = Object.keys(zip.files).filter(p => /\/views\/[^/]+\/view\.json$/.test(p) && !p.includes('__MACOSX'));
  if (viewFiles.length === 0){
    return { ok:false, error:'"'+fileName+'" não parece um projeto Ignition Perspective (não encontrei views/*/view.json).', summaryText:'' };
  }

  const views = [];
  for (const path of viewFiles){
    const viewName = path.match(/\/views\/([^/]+)\/view\.json$/)[1];
    let json;
    try{ json = JSON.parse(await zip.files[path].async('text')); }catch(e){ continue; }
    const acc = { typeCounts:{}, alarmComponents:[], trendComponents:[], tagBindings:new Set(), scripts:[] };
    walkPerspectiveComponent(json.root, acc);
    views.push({ name: viewName, ...acc, tagBindings: Array.from(acc.tagBindings) });
  }

  // page-config (navegação)
  let pages = [];
  const configPath = Object.keys(zip.files).find(p => /page-config\/config\.json$/.test(p) && !p.includes('__MACOSX'));
  if (configPath){
    try{
      const cfg = JSON.parse(await zip.files[configPath].async('text'));
      pages = Object.entries(cfg.pages || {}).map(([route, p]) => `${route} → ${p.viewPath}`);
    }catch(e){}
  }

  const lines = [];
  lines.push(`Arquivo: ${fileName}  |  ${views.length} tela(s)/view(s) encontrada(s)`);
  lines.push('');
  if (pages.length){
    lines.push('NAVEGAÇÃO (páginas configuradas):');
    pages.forEach(p => lines.push('  - ' + p));
    lines.push('');
  }
  views.forEach(v => {
    lines.push(`VIEW "${v.name}":`);
    lines.push('  componentes: ' + (Object.entries(v.typeCounts).map(([k,c])=>`${k}(${c})`).join(', ') || 'nenhum'));
    if (v.tagBindings.length) lines.push('  tags vinculadas: ' + v.tagBindings.join(', '));
    if (v.alarmComponents.length) lines.push('  ⚑ componente(s) de alarme: ' + v.alarmComponents.join(', '));
    if (v.trendComponents.length) lines.push('  ⚑ componente(s) de tendência/histórico (gráfico de tempo): ' + v.trendComponents.join(', '));
    if (v.scripts.length){
      lines.push('  scripts de evento:');
      v.scripts.forEach(s => lines.push(`    - [${s.component}] ${s.event}: ${s.script.replace(/\s+/g,' ')}`));
    }
    lines.push('');
  });

  return { ok:true, summaryText: lines.join('\n'), raw:{ views, pages } };
}

/* ==========================================================================
   PARSER — RELATÓRIO EM PDF
   ========================================================================== */
async function parseReportPDF(arrayBuffer, fileName, wantImages){
  let pdf;
  try{
    pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
  }catch(e){
    return { ok:false, error:'Não consegui abrir "'+fileName+'" como PDF: ' + e.message, summaryText:'', pageImages:[] };
  }
  const pageTexts = [];
  const pageImages = [];
  for (let i=1; i<=pdf.numPages; i++){
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    pageTexts.push(tc.items.map(it => it.str).join(' '));
    if (wantImages){
      try{
        const viewport = page.getViewport({scale: 1.15});
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({canvasContext: ctx, viewport}).promise;
        const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
        pageImages.push(dataUrl.split(',')[1]);
      }catch(e){ /* segue sem imagem dessa página */ }
    }
  }
  const lines = [];
  lines.push(`Arquivo: ${fileName}  |  ${pdf.numPages} página(s)`);
  lines.push('');
  pageTexts.forEach((t, i) => {
    lines.push(`--- página ${i+1} ---`);
    lines.push(t.trim() || '(sem texto extraível nesta página — pode ser só imagem/print)');
    lines.push('');
  });
  return { ok:true, summaryText: lines.join('\n'), pageImages, raw:{ pageCount: pdf.numPages, pageTexts } };
}



// Extrai o conteúdo de UM arquivo, devolvendo duas versões:
// - textoIA: pra mandar pro Gemini (pode ter cabeçalhos/estrutura, ajuda a IA a entender)
// - textoPlagio: só o conteúdo variável, sem rótulo/cabeçalho fixo (evita
//   falso positivo de plágio por coincidência de formatação, não de conteúdo)
// Usa parser especializado quando existe (CLP/.smbp, SCADA-Perspective/.zip,
// PDF), e cai pra extração genérica pra qualquer outro tipo — inclusive
// .ipynb (é JSON por baixo, dá pra ler célula por célula de verdade), zips
// que não são Perspective, e qualquer arquivo de texto puro.
// ---------------------------------------------------------------------
// Extração de "identificadores" candidatos (endereços de memória estilo
// %MW12/%Q0.3, caminhos de tag/variável tipo Motor1.Velocidade ou
// Motor1/Velocidade) usadas no cruzamento entre tipos de arquivo. É uma
// heurística por regex, não um parser da linguagem — serve pra achar
// coincidências prováveis, o professor/IA que julga se fazem sentido.
function extrairTokensCandidatos_(texto, limite){
  limite = limite || 200;
  const found = new Set();
  if (!texto) return [];
  for (const m of texto.matchAll(/%[A-Z]{1,3}\d+(?:\.\d+)?/g)) found.add(m[0].toUpperCase());
  for (const m of texto.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{1,30}(?:[./][A-Za-z_][A-Za-z0-9_]{1,30}){1,4}\b/g)){
    if (found.size >= limite) break;
    found.add(m[0]);
  }
  return Array.from(found).slice(0, limite);
}

function extrairIdentificadoresPython_(src){
  const ids = new Set();
  if (!src) return [];
  for (const m of src.matchAll(/^\s*(?:def|class)\s+([A-Za-z_]\w*)/gm)) ids.add(m[1]);
  for (const m of src.matchAll(/^\s*([A-Za-z_]\w*)\s*=(?!=)/gm)) ids.add(m[1]);
  for (const m of src.matchAll(/\[['"]([A-Za-z_][\w .%/-]{2,40})['"]\]/g)) ids.add(m[1]);
  for (const m of src.matchAll(/%[A-Z]{1,3}\d+(?:\.\d+)?/g)) ids.add(m[0].toUpperCase());
  return Array.from(ids).slice(0, 200);
}

function detectarDelimitadorTabular_(primeiraLinha){
  const candidatos = [',',';','\t'];
  let melhor = ','; let max = -1;
  candidatos.forEach((d) => {
    const c = primeiraLinha.split(d).length - 1;
    if (c > max){ max = c; melhor = d; }
  });
  return melhor;
}

function parseTabularTexto_(texto, fileName, delimForcado){
  const linhas = texto.split(/\r?\n/).filter((l) => l.length);
  if (!linhas.length) return { textoIA: `[arquivo ${fileName} vazio]`, textoPlagio: '', ids: [] };
  const delim = delimForcado || detectarDelimitadorTabular_(linhas[0]);
  const header = linhas[0].split(delim).map((c) => c.trim().replace(/^"|"$/g, ''));
  const nLinhas = linhas.length - 1;
  const amostra = linhas.slice(1, 6).map((l) => l.split(delim).map((c) => c.trim()).join(' | '));
  const textoIA = `Planilha ${fileName}: ${header.length} coluna(s), ${nLinhas} linha(s) de dados.\nColunas: ${header.join(', ')}\nAmostra (até 5 linhas):\n${amostra.join('\n')}`;
  const textoPlagio = header.join(' ') + ' ' + linhas.slice(1, 60).join(' ');
  const ids = new Set(header.filter(Boolean));
  extrairTokensCandidatos_(linhas.slice(0, 21).join(' '), 60).forEach((t) => ids.add(t));
  return { textoIA, textoPlagio, ids: Array.from(ids) };
}

// .xlsx é um zip com XML dentro (Office Open XML). Lê best-effort: strings
// compartilhadas (xl/sharedStrings.xml) + planilhas (xl/worksheets/sheetN.xml),
// sem depender de nenhuma lib externa de planilha (só o JSZip que já é usado
// pros projetos SCADA).
async function extrairXLSX_(buf, fileName){
  try{
    const zip = await JSZip.loadAsync(buf);
    const sheetFiles = Object.keys(zip.files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p)).sort();
    if (!sheetFiles.length) throw new Error('nenhuma planilha (xl/worksheets) encontrada dentro do arquivo');
    let sharedStrings = [];
    const ssFile = zip.file('xl/sharedStrings.xml');
    if (ssFile){
      const dom = new DOMParser().parseFromString(await ssFile.async('string'), 'application/xml');
      sharedStrings = Array.from(dom.getElementsByTagName('si')).map((si) => Array.from(si.getElementsByTagName('t')).map((t) => t.textContent).join(''));
    }
    const partesIA = []; const idsTotal = new Set(); const plagAmostra = [];
    for (const sf of sheetFiles.slice(0, 5)){
      const dom = new DOMParser().parseFromString(await zip.file(sf).async('string'), 'application/xml');
      const rows = Array.from(dom.getElementsByTagName('row'));
      const linhasTexto = rows.slice(0, 60).map((row) => Array.from(row.getElementsByTagName('c')).map((c) => {
        const vEl = c.getElementsByTagName('v')[0];
        if (!vEl) return '';
        return c.getAttribute('t') === 's' ? (sharedStrings[Number(vEl.textContent)] || '') : vEl.textContent;
      }).join(' | '));
      const header = linhasTexto[0] || '';
      partesIA.push(`--- aba ${sf.split('/').pop()} (${rows.length} linha(s)) ---\nCabeçalho: ${header}\nAmostra:\n${linhasTexto.slice(1, 6).join('\n')}`);
      header.split('|').map((s) => s.trim()).filter(Boolean).forEach((h) => idsTotal.add(h));
      plagAmostra.push(linhasTexto.join(' '));
    }
    return { textoIA: `Planilha ${fileName} (.xlsx):\n` + partesIA.join('\n\n'), textoPlagio: plagAmostra.join(' '), ids: Array.from(idsTotal) };
  }catch(e){ return { textoIA: `[erro ao ler planilha ${fileName}: ${e.message}]`, textoPlagio: '', ids: [] }; }
}

// .ods é o análogo OpenDocument: zip com content.xml em XML próprio
// (table:table / table:table-row / table:table-cell).
async function extrairODS_(buf, fileName){
  try{
    const zip = await JSZip.loadAsync(buf);
    const cfile = zip.file('content.xml');
    if (!cfile) throw new Error('content.xml não encontrado dentro do arquivo');
    const dom = new DOMParser().parseFromString(await cfile.async('string'), 'application/xml');
    const NS_TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
    const NS_TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
    const tables = Array.from(dom.getElementsByTagNameNS(NS_TABLE, 'table'));
    if (!tables.length) throw new Error('nenhuma tabela encontrada dentro do arquivo');
    const partesIA = []; const idsTotal = new Set(); const plagAmostra = [];
    tables.slice(0, 5).forEach((table) => {
      const rows = Array.from(table.getElementsByTagNameNS(NS_TABLE, 'table-row'));
      const linhasTexto = rows.slice(0, 60).map((row) => Array.from(row.getElementsByTagNameNS(NS_TABLE, 'table-cell'))
        .map((c) => Array.from(c.getElementsByTagNameNS(NS_TEXT, 'p')).map((p) => p.textContent).join(' ')).join(' | '));
      const nomeTabela = table.getAttributeNS(NS_TABLE, 'name') || '(sem nome)';
      const header = linhasTexto[0] || '';
      partesIA.push(`--- planilha "${nomeTabela}" (${rows.length} linha(s)) ---\nCabeçalho: ${header}\nAmostra:\n${linhasTexto.slice(1, 6).join('\n')}`);
      header.split('|').map((s) => s.trim()).filter(Boolean).forEach((h) => idsTotal.add(h));
      plagAmostra.push(linhasTexto.join(' '));
    });
    return { textoIA: `Planilha ${fileName} (.ods):\n` + partesIA.join('\n\n'), textoPlagio: plagAmostra.join(' '), ids: Array.from(idsTotal) };
  }catch(e){ return { textoIA: `[erro ao ler planilha ${fileName}: ${e.message}]`, textoPlagio: '', ids: [] }; }
}

// Tenta reconhecer um .json (ou .txt com JSON dentro) como exportação de
// tags do SCADA: varre recursivamente à procura de objetos com "name" +
// algum campo típico de definição de tag (opcItemPath/tagType/dataType/
// address). Se não achar nada com essa cara, retorna null e o chamador
// trata o arquivo como JSON/texto genérico.
function detectarEExtrairTagsScada_(jsonText){
  let obj;
  try{ obj = JSON.parse(jsonText); }catch(e){ return null; }
  const tags = [];
  const LIMITE = 400;
  (function walk(node, caminho){
    if (tags.length >= LIMITE) return;
    if (Array.isArray(node)){ node.forEach((n) => walk(n, caminho)); return; }
    if (!node || typeof node !== 'object') return;
    const nome = typeof node.name === 'string' ? node.name : null;
    const caminhoAtual = nome ? (caminho ? caminho + '/' + nome : nome) : caminho;
    const pareceTag = nome && (node.opcItemPath !== undefined || node.tagType !== undefined || node.dataType !== undefined || node.address !== undefined);
    if (pareceTag){
      tags.push({ path: caminhoAtual, dataType: node.dataType || node.tagType || '', origem: node.opcItemPath || node.address || '' });
    }
    Object.keys(node).forEach((k) => {
      const v = node[k];
      if (v && typeof v === 'object') walk(v, caminhoAtual);
    });
  })(obj, '');
  if (!tags.length) return null;
  return tags;
}

async function extrairConteudoArquivo(file, opcoes){
  opcoes = opcoes || {};
  const n = file.name.toLowerCase();

  if (n.endsWith('.smbp')){
    const texto = await file.text();
    const res = parseSMBP(texto, file.name);
    if (!res.ok) return { textoIA: `[erro ao ler ${file.name}: ${res.error}]`, textoPlagio: '', kind: 'CLP', ids: [] };
    const ids = [];
    (res.raw.symbols || []).forEach((s) => { if (s.address) ids.push(s.address); if (s.symbol) ids.push(s.symbol); });
    (res.raw.watchLists || []).forEach((wl) => (wl.items || []).forEach((it) => { if (it.address) ids.push(it.address); }));
    (res.raw.analogInputs || []).forEach((a) => { if (a.address) ids.push(a.address); });
    (res.raw.analogOutputs || []).forEach((a) => { if (a.address) ids.push(a.address); });
    return { textoIA: res.summaryText, textoPlagio: clpPlagContent(res.raw), kind: 'CLP', ids };
  }

  if (n.endsWith('.pdf')){
    const buf = await file.arrayBuffer();
    const res = await parseReportPDF(buf, file.name, opcoes.includeImages);
    if (!res.ok) return { textoIA: `[erro ao ler ${file.name}: ${res.error}]`, textoPlagio: '', kind: 'RELATORIO', ids: [] };
    if (opcoes.includeImages && opcoes.dossierRef && res.pageImages) opcoes.dossierRef.pageImages.push(...res.pageImages);
    const textoPlagio = (res.raw.pageTexts || []).map((t) => t.trim()).filter(Boolean).join(' ');
    // relatórios frequentemente documentam endereços/tags do CLP e SCADA no
    // próprio texto — extrai esses tokens candidatos pra permitir cruzar com
    // o que está de fato implementado nos outros arquivos.
    const ids = extrairTokensCandidatos_(textoPlagio, 150);
    return { textoIA: res.summaryText, textoPlagio, kind: 'RELATORIO', ids };
  }

  if (n.endsWith('.zip')){
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    const nomes = Object.keys(zip.files);
    const ehPerspective = nomes.some((p) => p.includes('com.inductiveautomation.perspective'));
    if (ehPerspective){
      const res = await parsePerspectiveZip(buf, file.name);
      if (!res.ok) return { textoIA: `[erro ao ler ${file.name}: ${res.error}]`, textoPlagio: '', kind: 'SCADA', ids: [] };
      const ids = [];
      (res.raw.views || []).forEach((v) => { if (v.name) ids.push(v.name); (v.tagBindings || []).forEach((t) => ids.push(t)); });
      return { textoIA: res.summaryText, textoPlagio: scadaPlagContent(res.raw), kind: 'SCADA', ids };
    }
    // zip genérico: extrai texto de todo arquivo que pareça texto de dentro dele
    const extsTexto = /\.(py|js|ts|txt|md|csv|json|xml|html|css|java|c|cpp|r|sql|yaml|yml|ipynb|qet)$/i;
    const partes = [];
    for (const nome of nomes){
      if (zip.files[nome].dir || !extsTexto.test(nome)) continue;
      if (partes.length >= 40) break; // limite de segurança
      try{ partes.push({ nome, conteudo: (await zip.files[nome].async('string')).slice(0, 8000) }); }
      catch(e){ /* arquivo dentro do zip não pôde ser lido como texto — ignora só ele */ }
    }
    const textoIA = partes.length
      ? partes.map((p) => `--- ${p.nome} ---\n${p.conteudo}`).join('\n\n')
      : `[zip entregue: ${file.name} — nenhum arquivo de texto reconhecido dentro dele]`;
    return { textoIA, textoPlagio: partes.map((p) => p.conteudo).join(' '), kind: 'GENERIC', ids: [] };
  }

  if (n.endsWith('.ipynb')){
    try{
      const nb = JSON.parse(await file.text());
      const partesIA = [];
      const partesPlagio = [];
      (nb.cells || []).forEach((cell, i) => {
        const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
        if (!src.trim()) return;
        partesIA.push(`[célula ${i + 1} — ${cell.cell_type}]\n${src}`);
        partesPlagio.push(src);
        (cell.outputs || []).forEach((out) => {
          const txt = out.text || (out.data && out.data['text/plain']);
          if (txt) partesIA.push('  saída: ' + (Array.isArray(txt) ? txt.join('') : txt).slice(0, 1000));
        });
      });
      const codigoTotal = partesPlagio.join('\n');
      return {
        textoIA: partesIA.join('\n\n') || `[notebook ${file.name} sem células com conteúdo]`,
        textoPlagio: codigoTotal,
        kind: 'PYTHON',
        ids: extrairIdentificadoresPython_(codigoTotal),
      };
    }catch(e){
      return { textoIA: `[erro ao ler notebook ${file.name}: ${e.message}]`, textoPlagio: '', kind: 'PYTHON', ids: [] };
    }
  }

  if (n.endsWith('.qet') || n.endsWith('.qet_project') || n.endsWith('.xml')){
    try{
      const text = await file.text();
      const labelMatches = Array.from(text.matchAll(/(?:label|text|name)="([^"]{2,60})"/gi)).map((m) => m[1]);
      const uniqueLabels = Array.from(new Set(labelMatches)).slice(0, 60);
      const contarTag = (tag) => (text.match(new RegExp('<' + tag + '\\b', 'gi')) || []).length;
      const contagens = [
        ['elementos', contarTag('element')],
        ['folios/diagramas', contarTag('diagram') || contarTag('folio')],
        ['terminais', contarTag('terminal')],
        ['condutores', contarTag('conductor')],
      ].filter(([, c]) => c > 0).map(([label, c]) => `${c} ${label}`).join(', ');
      const textoIA = uniqueLabels.length
        ? `Diagrama QElectroTech ${file.name}${contagens ? ' — ' + contagens : ''}.\nRótulos/textos encontrados no XML (não é uma leitura estrutural completa do esquema): ${uniqueLabels.join(', ')}`
        : `[XML ${file.name} sem rótulos identificáveis${contagens ? ' — ' + contagens : ''}]`;
      return { textoIA, textoPlagio: uniqueLabels.join(' '), kind: 'QET', ids: uniqueLabels };
    }catch(e){ return { textoIA: `[erro ao ler ${file.name}: ${e.message}]`, textoPlagio: '', kind: 'QET', ids: [] }; }
  }

  // .json e .txt: tenta primeiro reconhecer como exportação de tags do
  // SCADA (fica bem mais rico pro cruzamento CLP×SCADA×TAGS); se não bater
  // com essa estrutura, cai pro tratamento de texto genérico logo abaixo.
  if (n.endsWith('.json') || n.endsWith('.txt')){
    const texto = await file.text();
    const tags = detectarEExtrairTagsScada_(texto);
    if (tags){
      const linhas = tags.slice(0, 300).map((t) => `${t.path}${t.dataType ? ' [' + t.dataType + ']' : ''}${t.origem ? ' <- ' + t.origem : ''}`);
      const textoIA = `Exportação de tags do SCADA (${file.name}) — ${tags.length} tag(s) encontrada(s):\n${linhas.join('\n')}`;
      const ids = [];
      tags.forEach((t) => { if (t.path) ids.push(t.path); if (t.origem) ids.push(t.origem); });
      return { textoIA, textoPlagio: tags.map((t) => t.path + ' ' + (t.origem || '')).join(' '), kind: 'TAGS', ids };
    }
    const t = texto.slice(0, 20000);
    return { textoIA: t, textoPlagio: t, kind: 'GENERIC_TEXT', ids: extrairTokensCandidatos_(t, 60) };
  }

  if (n.endsWith('.csv') || n.endsWith('.tsv')){
    const texto = await file.text();
    const res = parseTabularTexto_(texto, file.name, n.endsWith('.tsv') ? '\t' : null);
    return { ...res, kind: 'PLANILHA' };
  }

  if (n.endsWith('.xlsx')){
    const buf = await file.arrayBuffer();
    const res = await extrairXLSX_(buf, file.name);
    return { ...res, kind: 'PLANILHA' };
  }

  if (n.endsWith('.ods')){
    const buf = await file.arrayBuffer();
    const res = await extrairODS_(buf, file.name);
    return { ...res, kind: 'PLANILHA' };
  }

  if (n.endsWith('.py')){
    const t = (await file.text()).slice(0, 20000);
    return { textoIA: t, textoPlagio: t, kind: 'PYTHON', ids: extrairIdentificadoresPython_(t) };
  }

  const extsTexto = ['.js','.ts','.md','.html','.css','.java','.c','.cpp','.r','.sql','.yaml','.yml','.svg'];
  if (extsTexto.some((e) => n.endsWith(e))){
    try{ const t = (await file.text()).slice(0, 20000); return { textoIA: t, textoPlagio: t, kind: 'GENERIC_TEXT', ids: [] }; }
    catch(e){ return { textoIA: `[erro ao ler ${file.name}: ${e.message}]`, textoPlagio: '', kind: 'GENERIC_TEXT', ids: [] }; }
  }

  return { textoIA: `[arquivo entregue: ${file.name} — formato binário, não foi possível extrair texto para a IA analisar]`, textoPlagio: '', kind: 'GENERIC', ids: [] };
}

// Extrai só o conteúdo VARIÁVEL (nunca os rótulos fixos do parser) do CLP e
// do SCADA especificamente — são os dois tipos cujo texto pra IA (summaryText)
// é cheio de cabeçalho fixo idêntico em todo mundo (ex.: "TABELAS DE
// ANIMAÇÃO..."), o que causaria falso positivo de plágio por coincidência
// de formatação. Outros tipos usam o texto extraído direto (ver
// extrairConteudoArquivo) porque não têm esse problema de boilerplate.
function clpPlagContent(raw){
  const parts = [];
  (raw.ladderPOUs || []).forEach(p => {
    parts.push(p.name);
    Object.entries(p.typeCounts || {}).forEach(([k, v]) => parts.push(`${k}${v}`));
  });
  if (raw.grafcet){
    raw.grafcet.steps.forEach(s => parts.push(s.name));
  }
  (raw.symbols || []).forEach(s => parts.push(s.symbol, s.address));
  (raw.watchLists || []).forEach(wl => {
    parts.push(wl.name);
    wl.items.forEach(it => parts.push(it.address + (it.traced ? ':traced' : '')));
  });
  (raw.analogInputs || []).forEach(a => parts.push(a.address));
  (raw.analogOutputs || []).forEach(a => parts.push(a.address));
  return parts.filter(Boolean).join(' ');
}

function scadaPlagContent(raw){
  const parts = [];
  (raw.views || []).forEach(v => {
    parts.push(v.name);
    Object.entries(v.typeCounts || {}).forEach(([k, c]) => parts.push(`${k}${c}`));
    (v.tagBindings || []).forEach(t => parts.push(t));
    (v.scripts || []).forEach(s => parts.push(s.script));
  });
  return parts.filter(Boolean).join(' ');
}

// Descobre a qual "tipo" (das regras de arquivo do trabalho) um arquivo
// pertence, em ordem de confiança:
// 1) _manifesto.json na pasta (gravado pelo Code.gs quando o aluno confirma
//    a entrega pelo enviartrabalho.html) — a fonte mais confiável.
// 2) nome padronizado aluno-idquestao-TIPO.ext (fluxo antigo de prova).
// 3) extensão do arquivo batendo com uma única regra configurada.
// 4) "OUTRO", se nada disso resolver.

// Nomes amigáveis dos "kind" estruturais (independem do rótulo que o
// professor deu ao tipo de arquivo — são baseados na EXTENSÃO/formato real).
const NOME_KIND = {
  CLP: 'Programa de CLP', SCADA: 'Projeto SCADA', TAGS: 'Tags do SCADA',
  QET: 'Diagrama elétrico (QET)', RELATORIO: 'Relatório (PDF)', PYTHON: 'Código Python',
  PLANILHA: 'Planilha/dados',
};

// Pares de "kind" que fazem sentido cruzar automaticamente (independe dos
// rótulos configurados pelo professor — olha pra estrutura real do arquivo).
const PARES_CRUZAMENTO_KIND = [
  ['CLP', 'SCADA'], ['CLP', 'TAGS'], ['SCADA', 'TAGS'],
  ['CLP', 'QET'], ['CLP', 'RELATORIO'], ['SCADA', 'RELATORIO'], ['QET', 'RELATORIO'],
  ['PYTHON', 'PLANILHA'], ['PYTHON', 'TAGS'], ['PYTHON', 'SCADA'], ['PYTHON', 'RELATORIO'],
];

function normalizarId_(s){
  return String(s || '').trim().toUpperCase().replace(/^["']|["']$/g, '');
}

// Cruzamento determinístico (sem IA) entre os identificadores (endereços,
// tags, rótulos, nomes de coluna/variável) extraídos de cada tipo de
// arquivo. Serve tanto pra alimentar o prompt de avaliação por IA em
// critérios marcados como "cruzados", quanto pra dar um diagnóstico rápido
// pro professor mesmo sem rodar a IA.
function buildCrossReferenceText(idsByKind){
  const blocos = [];
  PARES_CRUZAMENTO_KIND.forEach(([a, b]) => {
    const listaA = idsByKind[a], listaB = idsByKind[b];
    if (!listaA || !listaB || !listaA.length || !listaB.length) return;
    const setA = new Map(listaA.map((x) => [normalizarId_(x), x]).filter(([k]) => k));
    const setB = new Map(listaB.map((x) => [normalizarId_(x), x]).filter(([k]) => k));
    const comuns = [...setA.keys()].filter((k) => setB.has(k));
    const soA = [...setA.keys()].filter((k) => !setB.has(k));
    const soB = [...setB.keys()].filter((k) => !setA.has(k));
    if (!comuns.length && !soA.length && !soB.length) return;
    const nomeA = NOME_KIND[a] || a, nomeB = NOME_KIND[b] || b;
    let bloco = `${nomeA} × ${nomeB}: ${comuns.length} identificador(es) em comum`;
    if (comuns.length) bloco += ` (ex.: ${comuns.slice(0, 8).join(', ')})`;
    bloco += '.';
    if (soA.length) bloco += ` ${soA.length} usado(s) em "${nomeA}" sem correspondência aparente em "${nomeB}" (ex.: ${soA.slice(0, 6).join(', ')}).`;
    if (soB.length) bloco += ` ${soB.length} usado(s) em "${nomeB}" sem correspondência aparente em "${nomeA}" (ex.: ${soB.slice(0, 6).join(', ')}).`;
    blocos.push(bloco);
  });
  if (!blocos.length) return '';
  return blocos.map((b) => '- ' + b).join('\n')
    + '\n(Coincidência de nome/endereço é indício, não prova — nomes curtos podem coincidir por acaso; ausência pode ser um arquivo incompleto, não necessariamente um erro.)';
}
