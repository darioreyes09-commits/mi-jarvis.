const RTDB = process.env.FIREBASE_RTDB_URL; // https://control-gastos-proyectos-default-rtdb.firebaseio.com
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

const SYSTEM = `Eres JARVIS, el asistente de Darío Reyes en AFI (American Fire Import).
Responde en español, breve y directo. Cuando te pidan datos de proyectos, usa la herramienta consultar_proyecto.
Si la herramienta indica que hay ambigüedad, pregunta cuál proyecto quiere.`;

const TOOLS = [{
  name: "consultar_proyecto",
  description: "Consulta presupuesto, gasto acumulado, saldo y desglose por categoría de un proyecto de AFI, buscando por nombre o parte del nombre.",
  input_schema: {
    type: "object",
    properties: { nombre: { type: "string", description: "Nombre o parte del nombre del proyecto" } },
    required: ["nombre"]
  }
}];

const norm = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const money = n => Math.round(n).toLocaleString("es-DO");

async function getDB(path) {
  const r = await fetch(`${RTDB}/${path}.json`);
  if (!r.ok) throw new Error(`Firebase respondió ${r.status} en /${path}`);
  return r.json();
}

async function consultarProyecto(nombre) {
  const [projects, expenses] = await Promise.all([getDB("projects"), getDB("expenses")]);
  const q = norm(nombre);
  const all = Object.entries(projects || {});
  const matches = all.filter(([, p]) => norm(p.name).includes(q));

  if (matches.length === 0) {
    return { encontrado: false, mensaje: `Ningún proyecto coincide con "${nombre}".`, proyectos_disponibles: all.map(([, p]) => p.name) };
  }
  if (matches.length > 1) {
    return { encontrado: false, ambiguo: true, opciones: matches.map(([, p]) => p.name) };
  }

  const [id, p] = matches[0];
  const gastos = Object.values(expenses || {}).filter(e => e.projectId === id);
  const gastado = gastos.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const presupuesto = Number(p.budget) || 0;

  const porCategoria = {};
  for (const e of gastos) {
    const c = e.category || "Sin categoría";
    porCategoria[c] = (porCategoria[c] || 0) + (Number(e.amount) || 0);
  }

  return {
    encontrado: true,
    proyecto: p.name,
    cliente: p.client,
    presupuesto: money(presupuesto),
    gastado: money(gastado),
    saldo: money(presupuesto - gastado),
    porcentaje_ejecutado: presupuesto ? ((gastado / presupuesto) * 100).toFixed(1) + "%" : "n/d",
    gastos_registrados: gastos.length,
    por_categoria: Object.fromEntries(Object.entries(porCategoria).map(([k, v]) => [k, money(v)]))
  };
}

async function runTool(name, input) {
  if (name === "consultar_proyecto") return consultarProyecto(input.nombre);
  return { error: `Herramienta desconocida: ${name}` };
}

async function callClaude(messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1000, system: SYSTEM, tools: TOOLS, messages })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  return r.json();
}

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "{}" };

  try {
    const { messages } = JSON.parse(event.body || "{}");
    const convo = [...messages];

    // Bucle: el modelo puede pedir herramientas varias veces antes de responder
    for (let i = 0; i < 5; i++) {
      const data = await callClaude(convo);

      if (data.stop_reason !== "tool_use") {
        const text = data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
        return { statusCode: 200, headers, body: JSON.stringify({ text }) };
      }

      convo.push({ role: "assistant", content: data.content });
      const results = [];
      for (const block of data.content.filter(b => b.type === "tool_use")) {
        const out = await runTool(block.name, block.input);
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) });
      }
      convo.push({ role: "user", content: results });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ text: "No pude completar la consulta." }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};