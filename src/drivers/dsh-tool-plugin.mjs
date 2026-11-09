// Loaded only inside the fixed, isolated DSH profile. This plugin has no domain
// state: the owning js-superagent runtime checks every call and supplies results.
import { request, createServer } from 'node:http';
import { createDshNativeCollector } from './dsh-native-jobs.mjs';
import { createDshPreviewProducer } from './dsh-native-preview.mjs';

export const name = 'js-superagent-dsh-tools';
export const inject = ['tools', 'jobs'];
export async function apply(ctx, config) {
  const raw = process.env.JS_SUPERAGENT_DSH_BRIDGE;
  delete process.env.JS_SUPERAGENT_DSH_BRIDGE; // Native shell tools must not inherit the bridge capability.
  if (!raw) throw new Error('Missing DSH tool bridge capability');
  const connection = JSON.parse(raw), endpoint = new URL(connection.url);
  if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:' || typeof connection.token !== 'string') throw new Error('Invalid DSH bridge connection');
  let previewProducer;
  const previewCalls = new Map();
  const post = async (path, value) => {
    const response = await fetch(new URL(path, endpoint), { method: 'POST', signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: config.sessionId, ...value }) });
    if (!response.ok) throw new Error('Host rejected native job evidence');
    return response.json();
  };
  if (config.nativeHandoff) {
    if (!ctx.jobs || !['get','wait','readAt'].every(name => typeof ctx.jobs[name] === 'function')) throw new Error('DSH native jobs contract unavailable');
    if (config.definitions?.some(value => value.name === 'js_superagent_native_preview_start')) previewProducer=createDshPreviewProducer(ctx.jobs,{sessionId:config.sessionId,
      registerOwner:value=>post('/native/preview-owner',value),publish:value=>post('/native/preview-publish',value)});
    const collector = createDshNativeCollector(ctx.jobs, { sessionId: config.sessionId, emit: event => post('/native/event', { event }) });
    const server = createServer(async (req, res) => {
      try {
        if (req.method !== 'POST' || req.url !== '/collect' || req.headers.origin !== undefined || req.headers.authorization !== `Bearer ${connection.token}`) throw new Error();
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error(); }
        const value = JSON.parse(body);
        if (value.sessionId !== config.sessionId) throw new Error();
        const ack = value.action === 'renew-preview' ? previewProducer.renew(value.jobId,value.ttlMs) : collector.hold(value.jobIds);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(ack));
      } catch { res.writeHead(403); res.end('{}'); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    ctx.on('dispose', async () => { previewProducer?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await collector.close(); });
    await post('/native/register', { url: `http://127.0.0.1:${server.address().port}/collect` });
  }
  for (const definition of config.definitions ?? []) {
    ctx.tools.register({
      name: definition.name, description: definition.description, parameters: definition.inputSchema,
      output: { schema: {}, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      async execute(args, execution) {
        if (execution.agent?.session.id !== config.sessionId) throw new Error('Tool bridge session mismatch');
        if (definition.name === 'js_superagent_native_preview_start') {
          if (!previewProducer || !args || Object.keys(args).some(key=>key!=='profileId') || typeof args.profileId!=='string') throw new Error('Invalid native preview profile');
          const previous=previewCalls.get(execution.callId);
          if(previous&&previous.profileId!==args.profileId)throw new Error('Native preview identity conflict');
          if(previous)return previous.promise;
          const promise=post('/native/preview-authorize',{callId:execution.callId,profileId:args.profileId})
            .then(launch=>previewProducer.start(launch,{callId:execution.callId,rootCallId:execution.rootCallId??execution.callId}));
          previewCalls.set(execution.callId,{profileId:args.profileId,promise});return promise;
        }
        const body = JSON.stringify({ sessionId: execution.agent.session.id, callId: execution.callId, name: definition.name, arguments: args });
        if (Buffer.byteLength(body) > 48000) throw new Error('Tool bridge input exceeds budget');
        return await new Promise((resolve, reject) => {
          const req = request(endpoint, { method: 'POST', signal: execution.signal, headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
            let data = '';res.setEncoding('utf8');res.on('data', chunk => { data += chunk;if (Buffer.byteLength(data) > 64000) req.destroy(new Error('Tool bridge output exceeds budget')); });
            res.on('end', () => {
              try {
                if (res.statusCode !== 200) {
                  let reason = null;
                  try { reason = JSON.parse(data); } catch { /* keep the generic rejection */ }
                  throw new Error(typeof reason?.category === 'string' && typeof reason?.hint === 'string' ? `Host tool call rejected (${reason.category}): ${reason.hint}` : 'Host tool call rejected');
                }
                resolve(JSON.parse(data));
              } catch (error) { reject(error); }
            });
          });
          req.on('error', reject);req.end(body);
        });
      },
    });
  }
}
