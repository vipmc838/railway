#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const axios = require('axios');
const koffi = require('koffi');
const { execSync } = require('child_process');

try { require('dotenv').config(); } catch { /* ignore if dotenv unavailable */ }

// ======================== 环境变量定义 ========================
const UPLOAD_URL     = process.env.UPLOAD_URL     || '';         // 订阅或节点自动上传地址,需填写部署Merge-sub项目后的首页地址
const PROJECT_URL    = process.env.PROJECT_URL    || '';         // 需要上传订阅或保活时需填写项目分配的url
const AUTO_ACCESS    = process.env.AUTO_ACCESS    || false;      // false关闭自动保活，true开启,需同时填写PROJECT_URL变量
const YT_WARPOUT     = process.env.YT_WARPOUT     || false;      // 设置为true时强制使用warp出站访问youtube
const FILE_PATH      = process.env.FILE_PATH      || '.npm';     // sub.txt订阅文件路径
const SUB_PATH       = process.env.SUB_PATH       || 'sub';      // 订阅sub路径，默认为sub
const UUID           = process.env.UUID           || '32597759-58c2-4fa0-96f4-b6b94a5255da'; // UUID，运行哪吒请修改
const NEZHA_SERVER   = process.env.NEZHA_SERVER   || '';         // 哪吒面板地址，v1形式：nz.serv00.net:8008
const NEZHA_PORT     = process.env.NEZHA_PORT     || '';         // v1哪吒请留空，v0 agent端口
const NEZHA_KEY      = process.env.NEZHA_KEY      || '';         // v1的NZ_CLIENT_SECRET或v0 agent密钥
const ARGO_DOMAIN    = process.env.ARGO_DOMAIN    || '';         // argo固定隧道域名,留空即使用临时隧道
const ARGO_AUTH      = process.env.ARGO_AUTH      || '';         // argo固定隧道token或json,留空即使用临时隧道
const ARGO_PORT      = Number(process.env.ARGO_PORT) || 9527;    // argo固定隧道端口
const S5_PORT        = process.env.S5_PORT        || '';         // socks5端口，留空不启用
const TUIC_PORT      = process.env.TUIC_PORT      || '';         // tuic端口，留空不启用
const HY2_PORT       = process.env.HY2_PORT       || '';         // hy2端口，留空不启用
const ANYTLS_PORT    = process.env.ANYTLS_PORT    || '';         // AnyTLS端口，留空不启用
const REALITY_PORT   = process.env.REALITY_PORT   || '';         // reality端口，留空不启用
const CFIP           = process.env.CFIP           || 'saas.sin.fan'; // 优选域名或优选IP
const CFPORT         = Number(process.env.CFPORT) || 443;        // 优选域名或优选IP对应端口
const PORT           = Number(process.env.PORT)   || 8080;       // http订阅端口
const NAME           = process.env.NAME           || 'Railway-US';         // 节点名称
const CHAT_ID        = process.env.CHAT_ID        || '';         // Telegram chat_id，两个变量不全不推送
const BOT_TOKEN      = process.env.BOT_TOKEN      || '';         // Telegram bot_token，两个变量不全不推送
const DISABLE_ARGO   = process.env.DISABLE_ARGO   || false;      // 设置为true时禁用argo
// ==============================================================

const ROOT = process.cwd();
const runtimeFilePath = path.resolve(ROOT, FILE_PATH);
const libraryDir = runtimeFilePath;
const singBoxConfigPath = path.resolve(runtimeFilePath, 'config.json');
const nezhaConfigPath = path.resolve(runtimeFilePath, 'config.yaml');
const bootLogPath = path.resolve(runtimeFilePath, 'boot.log');
const subPath = path.resolve(runtimeFilePath, 'sub.txt');
const listPath = path.resolve(runtimeFilePath, 'list.txt');
const keypairPath = path.resolve(runtimeFilePath, 'keypair.properties');
const subscribePath = '/' + SUB_PATH.replace(/^\//, '');
const httpPort = PORT;

const arch = (() => {
  const a = os.arch().toLowerCase();
  if (a === 'arm64' || a === 'aarch64') return 'arm64';
  return 'amd64';
})();

let privateKey = '';
let publicKey = '';

// ======================== 辅助函数 ========================

function isValidPort(port) {
  try {
    if (port === null || port === undefined || port === '') return false;
    if (typeof port === 'string' && port.trim() === '') return false;
    const portNum = parseInt(port);
    if (isNaN(portNum)) return false;
    if (portNum < 1 || portNum > 65535) return false;
    return true;
  } catch (error) {
    return false;
  }
}

// ======================== 文件清理 ========================

const pathsToDelete = ['boot.log', 'list.txt', 'config.json', 'config.yaml', 'cert.pem', 'private.key', 'tunnel.json', 'tunnel.yml'];
function cleanupOldFiles() {
  pathsToDelete.forEach(file => {
    const filePath = path.join(FILE_PATH, file);
    fs.unlink(filePath, () => {});
  });
  const tmpDir = path.resolve(ROOT, '.tmp');
  if (fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { }
  }
}

function cleanupFiles(options = {}) {
  const keepFiles = new Set(['keypair.properties']);
  if (options.keepSub) keepFiles.add('sub.txt');
  if (fs.existsSync(runtimeFilePath)) {
    try {
      const files = fs.readdirSync(runtimeFilePath);
      for (const file of files) {
        if (keepFiles.has(file)) continue;
        const filePath = path.resolve(runtimeFilePath, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(filePath);
          }
        } catch (e) { /* skip locked/in-use files */ }
      }
    } catch (e) {
      console.error('Cleanup failed:', e.message);
    }
  }
  const tmpDir = path.resolve(ROOT, '.tmp');
  if (fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { }
  }
}

function clearConsole() {
  process.stdout.write('\x1Bc');
}

// ======================== 节点删除 ========================

function deleteNodes() {
  try {
    if (!UPLOAD_URL) return;
    if (!fs.existsSync(subPath)) return;
    let fileContent;
    try { fileContent = fs.readFileSync(subPath, 'utf-8'); } catch { return null; }
    const decoded = Buffer.from(fileContent, 'base64').toString('utf-8');
    const nodes = decoded.split('\n').filter(line =>
      /(vless|vmess|trojan|hysteria2|tuic):\/\//.test(line)
    );
    if (nodes.length === 0) return;
    return axios.post(`${UPLOAD_URL}/api/delete-nodes`,
      JSON.stringify({ nodes }),
      { headers: { 'Content-Type': 'application/json' } }
    ).catch(() => null);
  } catch (err) {
    return null;
  }
}

// ======================== Argo 隧道配置 ========================

function argoType() {
  if (DISABLE_ARGO === 'true' || DISABLE_ARGO === true) {
    console.log("DISABLE_ARGO is set to true, disable argo tunnel");
    return;
  }
  if (!ARGO_AUTH || !ARGO_DOMAIN) {
    console.log("ARGO_DOMAIN or ARGO_AUTH variable is empty, use quick tunnel");
    return;
  }
  if (ARGO_AUTH.includes('TunnelSecret')) {
    fs.writeFileSync(path.join(FILE_PATH, 'tunnel.json'), ARGO_AUTH);
    const tunnelYaml = `
  tunnel: ${ARGO_AUTH.split('"')[11]}
  credentials-file: ${path.join(FILE_PATH, 'tunnel.json')}
  protocol: http2
  
  ingress:
    - hostname: ${ARGO_DOMAIN}
      service: http://localhost:${ARGO_PORT}
      originRequest:
        noTLSVerify: true
    - service: http_status:404
  `;
    fs.writeFileSync(path.join(FILE_PATH, 'tunnel.yml'), tunnelYaml);
  } else {
    console.log(`Using token connect to tunnel, please set ${ARGO_PORT} in cloudflare`);
  }
}

// ======================== 下载库文件 ========================

async function sha256Matches(filePath, expected) {
  if (!expected) return true;
  const actual = await sha256(filePath);
  return actual.toLowerCase() === expected.toLowerCase();
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function downloadLibrary(url, fileName, expectedSha256) {
  const target = path.resolve(libraryDir, fileName);
  if (fs.existsSync(target) && await sha256Matches(target, expectedSha256)) {
    console.log(`Using cached native library: ${target}`);
    return target;
  }
  await fs.promises.mkdir(libraryDir, { recursive: true });
  const tmp = path.resolve(libraryDir, `${fileName}.download`);
  const writer = fs.createWriteStream(tmp);
  console.log(`Downloading ${url} -> ${target}`);
  const response = await axios.get(url, { responseType: 'stream', timeout: 3 * 60 * 1000 });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  response.data.pipe(writer);
  await new Promise((resolve, reject) => writer.on('finish', resolve).on('error', reject));
  if (!(await sha256Matches(tmp, expectedSha256))) {
    throw new Error(`SHA-256 mismatch for ${tmp}`);
  }
  await fs.promises.rename(tmp, target);
  return target;
}

// ======================== Koffi 服务管理 ========================

function createService(name, libraryPath, startSymbol, stopSymbol, payload) {
  const lib = koffi.load(libraryPath);
  const startFn = lib.func(`int ${startSymbol}(str)`);
  const stopFn = lib.func(`int ${stopSymbol}()`);
  return {
    name,
    start: () => {
      startFn.async(payload || '', (err, code) => {
        if (err) {
          console.error(`${name} native service failed: ${err.message}`);
        } else if (code !== 0) {
          console.warn(`${name} native service exited with code ${code}`);
        }
      });
    },
    stop: () => new Promise((resolve, reject) => {
      try {
        stopFn.async((err, code) => {
          if (err) return reject(err);
          resolve(code);
        });
      } catch (error) {
        resolve(-1);
      }
    })
  };
}

// ======================== Reality X25519 密钥对 (纯JS) ========================

const _X25519_P = (1n << 255n) - 19n;
const _X25519_A24 = 121665n;

function _clampScalar(buf) {
  buf[0] &= 248;
  buf[31] &= 127;
  buf[31] |= 64;
}

function _mod(value) {
  value = ((value % _X25519_P) + _X25519_P) % _X25519_P;
  return value;
}

function _decodeLE(buf) {
  let result = 0n;
  for (let i = buf.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(buf[i]);
  }
  return result;
}

function _encodeLE(value) {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return buf;
}

function _x25519(scalar, u) {
  let x1 = _decodeLE(u);
  let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n;
  let swap = 0;
  for (let t = 254; t >= 0; t--) {
    const byteIdx = Math.floor(t / 8);
    const kt = ((scalar[byteIdx] & 0xff) >> (t % 8)) & 1;
    swap ^= kt;
    if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
    swap = kt;
    const a = _mod(x2 + z2);
    const aa = _mod(a * a);
    const b = _mod(x2 - z2 + _X25519_P);
    const bb = _mod(b * b);
    const e = _mod(aa - bb + _X25519_P);
    const c = _mod(x3 + z3);
    const d = _mod(x3 - z3 + _X25519_P);
    const da = _mod(d * a);
    const cb = _mod(c * b);
    x3 = _mod((da + cb) * (da + cb));
    z3 = _mod(x1 * _mod((da - cb + _X25519_P) * (da - cb + _X25519_P)));
    x2 = _mod(aa * bb);
    z2 = _mod(e * _mod(aa + _X25519_A24 * e));
  }
  if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
  const z2inv = _modPow(z2, _X25519_P - 2n, _X25519_P);
  return _encodeLE(_mod(x2 * z2inv));
}

function _modPow(base, exp, mod) {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function generateRealityKeyPair() {
  const privateBytes = crypto.randomBytes(32);
  _clampScalar(privateBytes);
  const basepoint = Buffer.alloc(32);
  basepoint[0] = 9;
  const publicBytes = _x25519(privateBytes, basepoint);
  return {
    privateKey: privateBytes.toString('base64url'),
    publicKey: publicBytes.toString('base64url')
  };
}

function generateOrLoadKeyPair() {
  if (fs.existsSync(keypairPath)) {
    const content = fs.readFileSync(keypairPath, 'utf8');
    const privateKeyMatch = content.match(/PrivateKey:\s*(.*)/);
    const publicKeyMatch = content.match(/PublicKey:\s*(.*)/);
    if (privateKeyMatch && publicKeyMatch) {
      privateKey = privateKeyMatch[1];
      publicKey = publicKeyMatch[1];
      console.log('Private Key:', privateKey);
      console.log('Public Key:', publicKey);
      return;
    }
  }
  const pair = generateRealityKeyPair();
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  fs.writeFileSync(keypairPath, `PrivateKey: ${privateKey}\nPublicKey: ${publicKey}\n`, 'utf8');
  console.log('Private Key:', privateKey);
  console.log('Public Key:', publicKey);
}

// ======================== TLS 证书 ========================

const FALLBACK_EC_KEY =
  '-----BEGIN EC PARAMETERS-----\n' +
  'BggqhkjOPQMBBw==\n' +
  '-----END EC PARAMETERS-----\n' +
  '-----BEGIN EC PRIVATE KEY-----\n' +
  'MHcCAQEEIM4792SEtPqIt1ywqTd/0bYidBqpYV/++siNnfBYsdUYoAoGCCqGSM49\n' +
  'AwEHoUQDQgAE1kHafPj07rJG+HboH2ekAI4r+e6TL38GWASANnngZreoQDF16ARa\n' +
  '/TsyLyFoPkhLxSbehH/NBEjHtSZGaDhMqQ==\n' +
  '-----END EC PRIVATE KEY-----\n';

const FALLBACK_CERT =
  '-----BEGIN CERTIFICATE-----\n' +
  'MIIBejCCASGgAwIBAgIUfWeQL3556PNJLp/veCFxGNj9crkwCgYIKoZIzj0EAwIw\n' +
  'EzERMA8GA1UEAwwIYmluZy5jb20wHhcNMjUwOTE4MTgyMDIyWhcNMzUwOTE2MTgy\n' +
  'MDIyWjATMREwDwYDVQQDDAhiaW5nLmNvbTBZMBMGByqGSM49AgEGCCqGSM49AwEH\n' +
  'A0IABNZB2nz49O6yRvh26B9npACOK/nuky9/BlgEgDZ54Ga3qEAxdegEWv07Mi8h\n' +
  'aD5IS8Um3oR/zQRIx7UmRmg4TKmjUzBRMB0GA1UdDgQWBBTV1cFID7UISE7PLTBR\n' +
  'BfGbgkrMNzAfBgNVHSMEGDAWgBTV1cFID7UISE7PLTBRBfGbgkrMNzAPBgNVHRMB\n' +
  'Af8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIAIDAJvg0vd/ytrQVvEcSm6XTlB+\n' +
  'eQ6OFb9LbLYL9f+sAiAffoMbi4y/0YUSlTtz7as9S8/lciBF5VCUoVIKS+vX2g==\n' +
  '-----END CERTIFICATE-----\n';

function ensureTlsCertificates(certPath, keyPath) {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return;
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  try {
    execSync('openssl version', { stdio: 'ignore' });
    execSync(`openssl ecparam -genkey -name prime256v1 -out "${keyPath}"`, { stdio: 'ignore' });
    execSync(`openssl req -new -x509 -days 3650 -key "${keyPath}" -out "${certPath}" -subj "/CN=bing.com"`, { stdio: 'ignore' });
    return;
  } catch (e) { /* openssl not available */ }
  fs.writeFileSync(keyPath, FALLBACK_EC_KEY);
  fs.writeFileSync(certPath, FALLBACK_CERT);
}

// ======================== sing-box 配置生成 ========================

function generateSingBoxConfig(certPath, keyPath) {
  const inbounds = [];

  // VMess+WS inbound (for argo reverse proxy)
  inbounds.push({
    type: 'vmess',
    tag: 'vmess-ws-in',
    listen: '::',
    listen_port: ARGO_PORT,
    users: [{ uuid: UUID }],
    transport: {
      type: 'ws',
      path: '/vmess-argo',
      early_data_header_name: 'Sec-WebSocket-Protocol'
    }
  });

  // Reality
  if (isValidPort(REALITY_PORT)) {
    inbounds.push({
      type: 'vless',
      tag: 'vless-reality',
      listen: '::',
      listen_port: parseInt(REALITY_PORT),
      users: [{ uuid: UUID, flow: 'xtls-rprx-vision' }],
      tls: {
        enabled: true,
        server_name: 'www.iij.ad.jp',
        reality: {
          enabled: true,
          handshake: { server: 'www.iij.ad.jp', server_port: 443 },
          private_key: privateKey,
          short_id: ['']
        }
      }
    });
  }

  // Hysteria2
  if (isValidPort(HY2_PORT)) {
    inbounds.push({
      type: 'hysteria2',
      tag: 'hysteria-in',
      listen: '::',
      listen_port: parseInt(HY2_PORT),
      users: [{ password: UUID }],
      masquerade: 'https://bing.com',
      tls: {
        enabled: true,
        alpn: ['h3'],
        certificate_path: certPath,
        key_path: keyPath
      }
    });
  }

  // TUIC
  if (isValidPort(TUIC_PORT)) {
    inbounds.push({
      type: 'tuic',
      tag: 'tuic-in',
      listen: '::',
      listen_port: parseInt(TUIC_PORT),
      users: [{ uuid: UUID, password: UUID }],
      congestion_control: 'bbr',
      tls: {
        enabled: true,
        alpn: ['h3'],
        certificate_path: certPath,
        key_path: keyPath
      }
    });
  }

  // SOCKS5
  if (isValidPort(S5_PORT)) {
    inbounds.push({
      type: 'socks',
      tag: 's5-in',
      listen: '::',
      listen_port: parseInt(S5_PORT),
      users: [{
        username: UUID.substring(0, 8),
        password: UUID.slice(-12)
      }]
    });
  }

  // AnyTLS
  if (isValidPort(ANYTLS_PORT)) {
    inbounds.push({
      type: 'anytls',
      tag: 'anytls-in',
      listen: '::',
      listen_port: parseInt(ANYTLS_PORT),
      users: [{ password: UUID }],
      tls: {
        enabled: true,
        certificate_path: certPath,
        key_path: keyPath
      }
    });
  }

  // Wireguard endpoint + route rules
  const endpoints = [{
    type: 'wireguard',
    tag: 'wireguard-out',
    mtu: 1280,
    address: ['172.16.0.2/32', '2606:4700:110:8dfe:d141:69bb:6b80:925/128'],
    private_key: 'YFYOAdbw1bKTHlNNi+aEjBM3BO7unuFC5rOkMRAz9XY=',
    peers: [{
      address: 'engage.cloudflareclient.com',
      port: 2408,
      public_key: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
      allowed_ips: ['0.0.0.0/0', '::/0'],
      reserved: [78, 135, 76]
    }]
  }];

  const remoteRuleSet = (tag, url) => ({
    tag,
    type: 'remote',
    format: 'binary',
    url
  });
  const ruleSet = [
    remoteRuleSet('netflix', 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/netflix.srs'),
    remoteRuleSet('openai', 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/openai.srs')
  ];
  const wireguardRuleSets = ['netflix'];

  // YouTube WARP 出站检测
  let needYoutubeWarp = YT_WARPOUT === true || YT_WARPOUT === 'true';
  if (!needYoutubeWarp) {
    try {
      const youtubeTest = execSync('curl -o /dev/null -m 2 -s -w "%{http_code}" https://www.youtube.com', { encoding: 'utf8' }).trim();
      needYoutubeWarp = youtubeTest !== '200';
    } catch (curlError) {
      if (curlError.output && curlError.output[1]) {
        const test = curlError.output[1].toString().trim();
        needYoutubeWarp = test !== '200';
      } else {
        needYoutubeWarp = true;
      }
    }
  }
  if (needYoutubeWarp) {
    ruleSet.push(remoteRuleSet('youtube', 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/youtube.srs'));
    wireguardRuleSets.push('youtube');
    console.log('Add YouTube outbound rule');
  }

  const route = {
    default_http_client: 'http-client-direct',
    rule_set: ruleSet,
    rules: [{ rule_set: wireguardRuleSets, outbound: 'wireguard-out' }],
    final: 'direct'
  };

  return {
    log: { disabled: true, level: 'error', timestamp: true },
    http_clients: [{ tag: 'http-client-direct' }],
    inbounds,
    endpoints,
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route
  };
}

// ======================== nezha 配置生成 ========================

function generateNezhaConfig() {
  const nzport = NEZHA_SERVER.includes(':') ? NEZHA_SERVER.split(':').pop() : '';
  const tlsPorts = new Set(['443', '8443', '2096', '2087', '2083', '2053']);
  const nezhatls = tlsPorts.has(nzport) ? 'true' : 'false';
  const configYaml = `client_secret: ${NEZHA_KEY}
debug: false
disable_auto_update: true
disable_command_execute: false
disable_force_update: true
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: true
ip_report_period: 1800
report_delay: 4
server: ${NEZHA_SERVER}
skip_connection_count: true
skip_procs_count: true
temperature: false
tls: ${nezhatls}
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: ${UUID}`;
  fs.writeFileSync(nezhaConfigPath, configYaml, 'utf8');
}

// ======================== Cloudflared Payload ========================

function cloudflaredPayload() {
  if (DISABLE_ARGO === 'true' || DISABLE_ARGO === true) return null;
  if (ARGO_AUTH && ARGO_DOMAIN) {
    if (ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
      return JSON.stringify({
        args: ['tunnel', '--edge-ip-version', 'auto', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', ARGO_AUTH]
      });
    } else if (ARGO_AUTH.match(/TunnelSecret/)) {
      return JSON.stringify({
        args: ['tunnel', '--edge-ip-version', 'auto', '--config', path.join(FILE_PATH, 'tunnel.yml'), 'run']
      });
    }
  }
  // Quick tunnel
  return JSON.stringify({
    args: [
      'tunnel', '--edge-ip-version', 'auto', '--no-autoupdate',
      '--protocol', 'http2', '--logfile', bootLogPath,
      '--loglevel', 'info', '--url', `http://localhost:${ARGO_PORT}`
    ]
  });
}

function singBoxPayload() {
  return JSON.stringify({ config: singBoxConfigPath, workingDir: '.', disableColor: true });
}

function nezhaPayload() {
  return JSON.stringify({ config: nezhaConfigPath });
}

// ======================== 隧道域名检测 ========================

function waitForQuickTunnelDomain(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, 'utf8');
        const matches = [...content.matchAll(/https:\/\/([A-Za-z0-9.-]+\.trycloudflare\.com)/g)];
        if (matches.length > 0) {
          return matches[matches.length - 1][1];
        }
      }
    } catch (e) { /* file may not exist yet */ }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const sleepMs = Math.min(1000, remaining);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
  }
  return null;
}

async function extractDomain() {
  if (DISABLE_ARGO === 'true' || DISABLE_ARGO === true) return null;
  if (ARGO_AUTH && ARGO_DOMAIN) {
    console.log('ARGO_DOMAIN:', ARGO_DOMAIN);
    return ARGO_DOMAIN;
  }
  // Quick tunnel
  console.log('Waiting for quick tunnel domain in log...');
  let domain = waitForQuickTunnelDomain(bootLogPath, 30000);
  if (!domain) {
    console.log('Quick tunnel domain not found, retrying...');
    try { fs.unlinkSync(bootLogPath); } catch (e) { }
    await new Promise(r => setTimeout(r, 5000));
    domain = waitForQuickTunnelDomain(bootLogPath, 30000);
  }
  if (domain) {
    console.log('ArgoDomain:', domain);
  } else {
    console.log('ArgoDomain not found');
  }
  return domain;
}

// ======================== ISP 信息 ========================

async function getMetaInfo() {
  try {
    const response1 = await axios.get('https://api.ip.sb/geoip', { headers: { 'User-Agent': 'Mozilla/5.0', timeout: 3000 } });
    if (response1.data && response1.data.country_code && response1.data.isp) {
      return `${response1.data.country_code}-${response1.data.isp}`.replace(/\s+/g, '_');
    }
  } catch (error) {
    try {
      const response2 = await axios.get('http://ip-api.com/json', { headers: { 'User-Agent': 'Mozilla/5.0', timeout: 3000 } });
      if (response2.data && response2.data.status === 'success' && response2.data.countryCode && response2.data.org) {
        return `${response2.data.countryCode}-${response2.data.org}`.replace(/\s+/g, '_');
      }
    } catch (error) { /* backup also failed */ }
  }
  return 'Unknown';
}

// ======================== 节点链接生成 ========================

async function generateLinks(argoDomain) {
  let SERVER_IP = '';
  try {
    const ipv4Response = await axios.get('http://ipv4.ip.sb', { timeout: 3000 });
    SERVER_IP = ipv4Response.data.trim();
  } catch (err) {
    try {
      SERVER_IP = execSync('curl -sm 3 ipv4.ip.sb').toString().trim();
    } catch (curlErr) {
      try {
        const ipv6Response = await axios.get('http://ipv6.ip.sb', { timeout: 3000 });
        SERVER_IP = `[${ipv6Response.data.trim()}]`;
      } catch (ipv6AxiosErr) {
        try {
          SERVER_IP = `[${execSync('curl -sm 3 ipv6.ip.sb').toString().trim()}]`;
        } catch (ipv6CurlErr) {
          console.error('Failed to get IP address:', ipv6CurlErr.message);
        }
      }
    }
  }

  const ISP = await getMetaInfo();
  const nodeName = NAME ? `${NAME}-${ISP}` : ISP;

  await new Promise(r => setTimeout(r, 2000));

  let subTxt = '';

  // VMess+WS (argo)
  if ((DISABLE_ARGO !== 'true' && DISABLE_ARGO !== true) && argoDomain) {
    const vmessNode = `vmess://${Buffer.from(JSON.stringify({ v: '2', ps: `${nodeName}`, add: CFIP, port: CFPORT, id: UUID, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: argoDomain, path: '/vmess-argo?ed=2560', tls: 'tls', sni: argoDomain, alpn: '', fp: 'firefox' })).toString('base64')}`;
    subTxt = vmessNode;
  }

  // TUIC
  if (isValidPort(TUIC_PORT)) {
    subTxt += `\ntuic://${UUID}:${UUID}@${SERVER_IP}:${TUIC_PORT}?sni=www.bing.com&congestion_control=bbr&udp_relay_mode=native&alpn=h3&allow_insecure=1#${nodeName}`;
  }

  // Hysteria2
  if (isValidPort(HY2_PORT)) {
    subTxt += `\nhysteria2://${UUID}@${SERVER_IP}:${HY2_PORT}/?sni=www.bing.com&insecure=1&alpn=h3&obfs=none#${nodeName}`;
  }

  // Reality
  if (isValidPort(REALITY_PORT)) {
    subTxt += `\nvless://${UUID}@${SERVER_IP}:${REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.iij.ad.jp&fp=firefox&pbk=${publicKey}&type=tcp&headerType=none#${nodeName}`;
  }

  // AnyTLS
  if (isValidPort(ANYTLS_PORT)) {
    subTxt += `\nanytls://${UUID}@${SERVER_IP}:${ANYTLS_PORT}?security=tls&sni=${SERVER_IP}&fp=chrome&insecure=1&allowInsecure=1#${nodeName}`;
  }

  // SOCKS5
  if (isValidPort(S5_PORT)) {
    const S5_AUTH = Buffer.from(`${UUID.substring(0, 8)}:${UUID.slice(-12)}`).toString('base64');
    subTxt += `\nsocks://${S5_AUTH}@${SERVER_IP}:${S5_PORT}#${nodeName}`;
  }

  // 打印绿色 base64 编码
  console.log('\x1b[32m' + Buffer.from(subTxt).toString('base64') + '\x1b[0m');
  console.log('\x1b[35m' + 'Logs will be deleted in 45 seconds, you can copy the above nodes' + '\x1b[0m');

  fs.writeFileSync(subPath, Buffer.from(subTxt).toString('base64'));
  fs.writeFileSync(listPath, subTxt, 'utf8');
  console.log(`${FILE_PATH}/sub.txt saved successfully`);

  return subTxt;
}

// ======================== Telegram 推送 ========================

async function sendTelegram() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('TG variables is empty, Skipping push nodes to TG');
    return;
  }
  try {
    const message = fs.readFileSync(subPath, 'utf8');
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const escapedName = NAME.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const params = {
      chat_id: CHAT_ID,
      text: `**${escapedName}节点推送通知**\n\`\`\`${message}\`\`\``,
      parse_mode: 'MarkdownV2'
    };
    await axios.post(url, null, { params });
    console.log('Telegram message sent successfully');
  } catch (error) {
    console.error('Failed to send Telegram message', error);
  }
}

// ======================== 节点上传 ========================

async function uploadNodes() {
  if (UPLOAD_URL && PROJECT_URL) {
    const subscriptionUrl = `${PROJECT_URL}/${SUB_PATH}`;
    const jsonData = { subscription: [subscriptionUrl] };
    try {
      const response = await axios.post(`${UPLOAD_URL}/api/add-subscriptions`, jsonData, {
        headers: { 'Content-Type': 'application/json' }
      });
      if (response.status === 200) console.log('Subscription uploaded successfully');
    } catch (error) { /* ignore */ }
  } else if (UPLOAD_URL) {
    if (!fs.existsSync(listPath)) return;
    const content = fs.readFileSync(listPath, 'utf-8');
    const nodes = content.split('\n').filter(line => /(vless|vmess|trojan|hysteria2|tuic):\/\//.test(line));
    if (nodes.length === 0) return;
    try {
      const response = await axios.post(`${UPLOAD_URL}/api/add-nodes`,
        JSON.stringify({ nodes }),
        { headers: { 'Content-Type': 'application/json' } }
      );
      if (response.status === 200) console.log('Subscription uploaded successfully');
    } catch (error) { /* ignore */ }
  }
}

// ======================== 自动保活 ========================

async function addVisitTask() {
  if (!AUTO_ACCESS || !PROJECT_URL) {
    console.log('Skipping adding automatic access task');
    return;
  }
  try {
    await axios.post('https://keep.gvrander.eu.org/add-url', {
      url: PROJECT_URL
    }, { headers: { 'Content-Type': 'application/json' } });
    console.log('Automatic access task added successfully');
  } catch (error) {
    console.error(`Add URL failed: ${error.message}`);
  }
}

// ======================== HTTP 服务器 ========================

function startHttpServer(subTxt) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }
    const url = new URL(req.url, `http://localhost`);
    if (url.pathname === subscribePath) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      const encodedContent = Buffer.from(subTxt).toString('base64');
      res.end(encodedContent);
    } else if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nexify | AI Automation Suite — No‑Code Intelligence</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300;14..32,400;14..32,500;14..32,600;14..32,700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Inter', sans-serif;
            line-height: 1.6;
            color: #1e1f2a;
            background-color: #fefcff;
        }

        h1, h2, h3, h4, .logo-text, .plan-name, .nav-links a, .cta-button, .secondary-button {
            font-family: 'Plus Jakarta Sans', sans-serif;
        }

        .container {
            width: 100%;
            max-width: 1280px;
            margin: 0 auto;
            padding: 0 24px;
        }

        /* Header & Navigation */
        header {
            background-color: rgba(255, 255, 255, 0.96);
            backdrop-filter: blur(8px);
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 2px 8px rgba(0, 0, 0, 0.02);
            position: fixed;
            width: 100%;
            z-index: 1000;
            transition: all 0.2s;
        }

        nav {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 18px 0;
        }

        .logo {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .logo-icon {
            color: #8b5cf6;
            font-size: 28px;
            background: linear-gradient(135deg, #8b5cf6 0%, #c084fc 100%);
            background-clip: text;
            -webkit-background-clip: text;
            color: transparent;
        }

        .logo-text {
            font-size: 26px;
            font-weight: 800;
            color: #0f0e17;
            letter-spacing: -0.3px;
        }

        .logo-text span {
            background: linear-gradient(120deg, #8b5cf6, #c084fc);
            background-clip: text;
            -webkit-background-clip: text;
            color: transparent;
        }

        .nav-links {
            display: flex;
            list-style: none;
            gap: 36px;
        }

        .nav-links a {
            text-decoration: none;
            color: #3c3e4a;
            font-weight: 600;
            font-size: 1rem;
            transition: color 0.2s;
        }

        .nav-links a:hover {
            color: #8b5cf6;
        }

        .cta-button {
            background: linear-gradient(105deg, #8b5cf6 0%, #a855f7 100%);
            color: white;
            border: none;
            padding: 10px 26px;
            border-radius: 40px;
            font-weight: 700;
            font-size: 0.95rem;
            cursor: pointer;
            transition: all 0.25s ease;
            box-shadow: 0 4px 12px rgba(139, 92, 246, 0.25);
        }

        .cta-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(139, 92, 246, 0.3);
            background: linear-gradient(105deg, #7c3aed, #9333ea);
        }

        .secondary-button {
            background-color: transparent;
            color: #8b5cf6;
            border: 1.5px solid #d9c9ff;
            padding: 10px 26px;
            border-radius: 40px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }

        .secondary-button:hover {
            background-color: #f5f0ff;
            border-color: #8b5cf6;
        }

        .mobile-menu-btn {
            display: none;
            background: none;
            border: none;
            font-size: 26px;
            color: #1e1f2a;
            cursor: pointer;
        }

        /* Hero Section */
        .hero {
            padding: 160px 0 90px;
            background: radial-gradient(ellipse 80% 50% at 20% 40%, #f3eaff, #ffffff);
        }

        .hero-content {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 48px;
        }

        .hero-text {
            flex: 1;
        }

        .hero-text h1 {
            font-size: 52px;
            font-weight: 800;
            line-height: 1.2;
            letter-spacing: -0.02em;
            margin-bottom: 24px;
            color: #0f0e17;
        }

        .hero-text h1 span {
            background: linear-gradient(135deg, #8b5cf6, #c241ff);
            background-clip: text;
            -webkit-background-clip: text;
            color: transparent;
        }

        .hero-text p {
            font-size: 1.2rem;
            color: #4b4b5a;
            margin-bottom: 36px;
            max-width: 540px;
        }

        .hero-buttons {
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
        }

        .hero-image {
            flex: 1;
            text-align: center;
        }

        .hero-image img {
            max-width: 100%;
            border-radius: 28px;
            box-shadow: 0 25px 45px -12px rgba(0, 0, 0, 0.2);
            border: 1px solid rgba(139, 92, 246, 0.15);
        }

        /* Section titles */
        .section-title {
            text-align: center;
            margin-bottom: 64px;
        }

        .section-title h2 {
            font-size: 38px;
            font-weight: 700;
            color: #0f0e17;
            letter-spacing: -0.01em;
            margin-bottom: 16px;
        }

        .section-title p {
            color: #5b5c6e;
            max-width: 700px;
            margin: 0 auto;
            font-size: 1.1rem;
        }

        /* Features */
        .features {
            padding: 100px 0;
            background-color: #ffffff;
        }

        .features-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 40px;
        }

        .feature-card {
            background: #fff;
            padding: 32px 28px;
            border-radius: 28px;
            box-shadow: 0 8px 20px rgba(0, 0, 0, 0.02), 0 2px 6px rgba(0, 0, 0, 0.03);
            transition: all 0.3s ease;
            border: 1px solid #f0eaff;
        }

        .feature-card:hover {
            transform: translateY(-8px);
            border-color: #d9c9ff;
            box-shadow: 0 20px 30px -12px rgba(139, 92, 246, 0.15);
        }

        .feature-icon {
            background: #f2ecff;
            color: #8b5cf6;
            width: 64px;
            height: 64px;
            border-radius: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 24px;
            font-size: 28px;
        }

        .feature-card h3 {
            font-size: 1.6rem;
            font-weight: 700;
            margin-bottom: 14px;
        }

        .feature-card p {
            color: #5a5b6e;
            line-height: 1.5;
        }

        /* Benefits */
        .benefits {
            padding: 100px 0;
            background-color: #fbfaff;
        }

        .benefits-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
            gap: 40px;
        }

        .benefit-item {
            text-align: center;
            padding: 28px 20px;
            background: white;
            border-radius: 28px;
            transition: all 0.2s;
            border: 1px solid #f0ebff;
        }

        .benefit-icon {
            color: #8b5cf6;
            font-size: 44px;
            margin-bottom: 20px;
        }

        .benefit-item h3 {
            font-size: 1.6rem;
            font-weight: 700;
            margin-bottom: 12px;
        }

        .benefit-item p {
            color: #5a5b6e;
        }

        /* Testimonials */
        .testimonials {
            padding: 100px 0;
            background: white;
        }

        .testimonial-slider {
            max-width: 850px;
            margin: 0 auto;
        }

        .testimonial {
            background: #fefbff;
            padding: 48px 44px;
            border-radius: 40px;
            text-align: center;
            box-shadow: 0 12px 28px -8px rgba(0, 0, 0, 0.05);
            border: 1px solid #ede6ff;
        }

        .testimonial-text {
            font-size: 1.28rem;
            font-style: normal;
            font-weight: 500;
            margin-bottom: 32px;
            color: #252641;
            line-height: 1.45;
        }

        .testimonial-author {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 16px;
        }

        .author-avatar {
            width: 56px;
            height: 56px;
            border-radius: 100%;
            background: linear-gradient(145deg, #e9deff, #d9c9ff);
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            font-size: 1.2rem;
            color: #6d28d9;
        }

        .author-info h4 {
            font-size: 1.2rem;
            margin-bottom: 4px;
        }

        .author-info p {
            color: #6c6d80;
            font-size: 0.85rem;
        }

        /* Pricing */
        .pricing {
            padding: 100px 0;
            background: #fefaff;
        }

        .pricing-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 32px;
        }

        .pricing-card {
            background: white;
            border-radius: 36px;
            padding: 40px 28px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.03);
            text-align: center;
            transition: all 0.25s;
            border: 1px solid #ede6ff;
        }

        .pricing-card.featured {
            border-top: 6px solid #8b5cf6;
            position: relative;
            transform: scale(1.02);
            box-shadow: 0 20px 35px -12px rgba(139, 92, 246, 0.2);
        }

        .featured-badge {
            position: absolute;
            top: -14px;
            left: 50%;
            transform: translateX(-50%);
            background: #8b5cf6;
            color: white;
            padding: 6px 20px;
            border-radius: 60px;
            font-size: 0.8rem;
            font-weight: 700;
        }

        .pricing-card:hover {
            transform: translateY(-8px);
        }

        .pricing-card.featured:hover {
            transform: scale(1.02) translateY(-8px);
        }

        .plan-name {
            font-size: 1.8rem;
            font-weight: 700;
            margin-bottom: 18px;
        }

        .plan-price {
            font-size: 3rem;
            font-weight: 800;
            color: #8b5cf6;
            margin-bottom: 24px;
        }

        .plan-price span {
            font-size: 1rem;
            color: #7f7f92;
            font-weight: 500;
        }

        .plan-features {
            list-style: none;
            margin-bottom: 32px;
        }

        .plan-features li {
            padding: 12px 0;
            border-bottom: 1px solid #f0eaff;
            color: #454658;
            font-weight: 500;
        }

        .plan-features li:last-child {
            border-bottom: none;
        }

        /* CTA Section */
        .cta-section {
            padding: 100px 0;
            background: linear-gradient(125deg, #1e1a3a 0%, #2b1e4e 100%);
            text-align: center;
            color: white;
        }

        .cta-section h2 {
            font-size: 2.6rem;
            margin-bottom: 20px;
        }

        .cta-section p {
            font-size: 1.2rem;
            max-width: 650px;
            margin: 0 auto 32px;
            opacity: 0.85;
        }

        .cta-section .cta-button {
            background: white;
            color: #6d28d9;
            box-shadow: none;
            font-size: 1rem;
            padding: 14px 38px;
        }

        .cta-section .cta-button:hover {
            background: #f5f0ff;
            transform: translateY(-2px);
        }

        /* Footer */
        footer {
            background-color: #0c0b15;
            color: #a8a9bc;
            padding: 70px 0 24px;
        }

        .footer-content {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 48px;
            margin-bottom: 56px;
        }

        .footer-column h3 {
            font-size: 1.2rem;
            color: #eef2ff;
            margin-bottom: 22px;
            font-weight: 600;
        }

        .footer-links {
            list-style: none;
        }

        .footer-links li {
            margin-bottom: 12px;
        }

        .footer-links a {
            color: #b9bad2;
            text-decoration: none;
            transition: color 0.2s;
        }

        .footer-links a:hover {
            color: #c084fc;
        }

        .copyright {
            text-align: center;
            padding-top: 28px;
            border-top: 1px solid #24213a;
            font-size: 0.85rem;
        }

        /* Responsive */
        @media (max-width: 992px) {
            .hero-content {
                flex-direction: column;
                text-align: center;
            }
            .hero-text p {
                margin: 0 auto 30px;
            }
            .hero-buttons {
                justify-content: center;
            }
            .pricing-card.featured {
                transform: none;
            }
        }

        @media (max-width: 768px) {
            .nav-links {
                display: none;
            }
            .mobile-menu-btn {
                display: block;
            }
            .hero-text h1 {
                font-size: 38px;
            }
            .section-title h2 {
                font-size: 30px;
            }
            .testimonial {
                padding: 32px 24px;
            }
            .testimonial-text {
                font-size: 1rem;
            }
        }

        @media (max-width: 560px) {
            .hero {
                padding: 130px 0 70px;
            }
            .feature-card, .benefit-item, .pricing-card {
                padding: 24px 20px;
            }
        }
    </style>
</head>
<body>
    <header>
        <div class="container">
            <nav>
                <div class="logo">
                    <div class="logo-icon"><i class="fas fa-robot"></i></div>
                    <div class="logo-text">Nex<span>ify</span></div>
                </div>
                <ul class="nav-links">
                    <li><a href="#features">Capabilities</a></li>
                    <li><a href="#benefits">Why Nexify</a></li>
                    <li><a href="#testimonials">Stories</a></li>
                    <li><a href="#pricing">Plans</a></li>
                    <li><a href="#">Resources</a></li>
                </ul>
                <button class="cta-button">Try free →</button>
                <button class="mobile-menu-btn"><i class="fas fa-bars"></i></button>
            </nav>
        </div>
    </header>

    <section class="hero">
        <div class="container">
            <div class="hero-content">
                <div class="hero-text">
                    <h1>Intelligent workflows, <span>built without limits</span></h1>
                    <p>Nexify empowers teams to design, automate, and scale AI-native applications — no deep coding required. Connect models, data, and logic visually.</p>
                    <div class="hero-buttons">
                        <button class="cta-button">Start building free</button>
                        <button class="secondary-button">Watch demo</button>
                    </div>
                </div>
                <div class="hero-image">
                    <img src="https://images.unsplash.com/photo-1581291518633-83b4ebd1d83e?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80" alt="Nexify AI Dashboard concept">
                </div>
            </div>
        </div>
    </section>

    <section class="features" id="features">
        <div class="container">
            <div class="section-title">
                <h2>Everything you need to build with AI</h2>
                <p>From prototype to production, Nexify combines no‑code simplicity with professional flexibility.</p>
            </div>
            <div class="features-grid">
                <div class="feature-card">
                    <div class="feature-icon"><i class="fas fa-cubes"></i></div>
                    <h3>Visual AI Builder</h3>
                    <p>Drag & drop pre‑trained models, prompt nodes, and logic gates. Build complex AI chains in minutes.</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon"><i class="fas fa-database"></i></div>
                    <h3>Unified Data Hub</h3>
                    <p>Connect to databases, CRMs, or vector stores. Sync live data without writing SQL or API glue.</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon"><i class="fas fa-cloud-upload-alt"></i></div>
                    <h3>Deploy anywhere</h3>
                    <p>One‑click cloud deployment or self‑hosted on your infrastructure. Auto‑scaling out of the box.</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon"><i class="fas fa-brain"></i></div>
                    <h3>LLM playground</h3>
                    <p>Compare GPT-4o, Claude, Gemini, and open‑source models. Tune prompts without code.</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon"><i class="fas fa-shield-hooded"></i></div>
                    <h3>Enterprise security</h3>
                    <p>SSO, RBAC, data encryption, and audit logs — ready for regulated industries.</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon"><i class="fas fa-chalkboard-user"></i></div>
                    <h3>Human-in-the-loop</h3>
                    <p>Add approvals, reviews, and fallback logic to keep AI workflows reliable and safe.</p>
                </div>
            </div>
        </div>
    </section>

    <section class="benefits" id="benefits">
        <div class="container">
            <div class="section-title">
                <h2>Why forward‑thinking teams choose Nexify</h2>
                <p>Accelerate AI adoption without sacrificing control or creativity.</p>
            </div>
            <div class="benefits-grid">
                <div class="benefit-item">
                    <div class="benefit-icon"><i class="fas fa-gauge-high"></i></div>
                    <h3>5x faster delivery</h3>
                    <p>Build AI features in days instead of sprints — from idea to working prototype.</p>
                </div>
                <div class="benefit-item">
                    <div class="benefit-icon"><i class="fas fa-coins"></i></div>
                    <h3>Reduce costs by 65%</h3>
                    <p>Cut infrastructure overhead and developer hours with visual tooling.</p>
                </div>
                <div class="benefit-item">
                    <div class="benefit-icon"><i class="fas fa-chalkboard"></i></div>
                    <h3>Empower domain experts</h3>
                    <p>Let product owners and analysts build intelligent automations safely.</p>
                </div>
                <div class="benefit-item">
                    <div class="benefit-icon"><i class="fas fa-arrow-trend-up"></i></div>
                    <h3>Future‑proof scaling</h3>
                    <p>From hackathon MVP to mission‑critical AI platform on the same stack.</p>
                </div>
            </div>
        </div>
    </section>

    <section class="testimonials" id="testimonials">
        <div class="container">
            <div class="section-title">
                <h2>Loved by AI pioneers & enterprises</h2>
                <p>Join thousands of builders who ship faster with Nexify.</p>
            </div>
            <div class="testimonial-slider">
                <div class="testimonial">
                    <div class="testimonial-text">“Nexify turned our AI pilots into production‑ready systems within 6 weeks. The visual workflow builder made collaboration between ML engineers and product teams seamless.”</div>
                    <div class="testimonial-author">
                        <div class="author-avatar">DR</div>
                        <div class="author-info">
                            <h4>Dr. Elena Rossi</h4>
                            <p>Head of AI, Vectra Health</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>

    <section class="pricing" id="pricing">
        <div class="container">
            <div class="section-title">
                <h2>Simple plans, limitless potential</h2>
                <p>Start free, upgrade when you grow. All plans include core AI building blocks.</p>
            </div>
            <div class="pricing-grid">
                <div class="pricing-card">
                    <h3 class="plan-name">Starter</h3>
                    <div class="plan-price">$39<span>/month</span></div>
                    <ul class="plan-features">
                        <li>Up to 5 team members</li>
                        <li>20 GB vector storage</li>
                        <li>Pre‑built AI components</li>
                        <li>Community support</li>
                        <li>2 production apps</li>
                    </ul>
                    <button class="secondary-button">Start free trial</button>
                </div>
                <div class="pricing-card featured">
                    <div class="featured-badge">🔥 Most popular</div>
                    <h3 class="plan-name">Pro</h3>
                    <div class="plan-price">$99<span>/month</span></div>
                    <ul class="plan-features">
                        <li>Up to 20 members</li>
                        <li>200 GB + vector DB</li>
                        <li>All LLM models & fine‑tuning</li>
                        <li>Priority chat support</li>
                        <li>Unlimited apps + API access</li>
                        <li>Custom prompt libraries</li>
                    </ul>
                    <button class="cta-button">Try 14 days free</button>
                </div>
                <div class="pricing-card">
                    <h3 class="plan-name">Enterprise</h3>
                    <div class="plan-price">Custom</div>
                    <ul class="plan-features">
                        <li>Unlimited seats</li>
                        <li>Unlimited storage & throughput</li>
                        <li>SLA 99.9% uptime</li>
                        <li>24/7 dedicated support</li>
                        <li>On‑prem / VPC deployment</li>
                        <li>Custom AI model hosting</li>
                    </ul>
                    <button class="secondary-button">Contact sales</button>
                </div>
            </div>
        </div>
    </section>

    <section class="cta-section">
        <div class="container">
            <h2>Launch your first AI agent today</h2>
            <p>No credit card required. Build, test, and deploy intelligent workflows in minutes — not months.</p>
            <button class="cta-button">Get started for free →</button>
        </div>
    </section>

    <footer>
        <div class="container">
            <div class="footer-content">
                <div class="footer-column">
                    <div class="logo">
                        <div class="logo-icon"><i class="fas fa-robot"></i></div>
                        <div class="logo-text">Nex<span>ify</span></div>
                    </div>
                    <p style="margin-top: 20px; color: #b9bad2;">The modern AI automation suite built for business & engineering teams.</p>
                </div>
                <div class="footer-column">
                    <h3>Platform</h3>
                    <ul class="footer-links">
                        <li><a href="#">Features</a></li>
                        <li><a href="#">Integrations</a></li>
                        <li><a href="#">AI models</a></li>
                        <li><a href="#">Security</a></li>
                        <li><a href="#">Roadmap</a></li>
                    </ul>
                </div>
                <div class="footer-column">
                    <h3>Resources</h3>
                    <ul class="footer-links">
                        <li><a href="#">Documentation</a></li>
                        <li><a href="#">Guides & tutorials</a></li>
                        <li><a href="#">Blog</a></li>
                        <li><a href="#">Community</a></li>
                        <li><a href="#">API reference</a></li>
                    </ul>
                </div>
                <div class="footer-column">
                    <h3>Company</h3>
                    <ul class="footer-links">
                        <li><a href="#">About Nexify</a></li>
                        <li><a href="#">Careers</a></li>
                        <li><a href="#">Press</a></li>
                        <li><a href="#">Privacy & terms</a></li>
                        <li><a href="#">Contact</a></li>
                    </ul>
                </div>
            </div>
            <div class="copyright">
                <p>&copy; 2025 Nexify. All rights reserved. Intelligent automation for everyone.</p>
            </div>
        </div>
    </footer>

    <script>
        (function(){
            // Mobile menu toggle
            const mobileBtn = document.querySelector('.mobile-menu-btn');
            const navLinks = document.querySelector('.nav-links');
            
            if(mobileBtn) {
                mobileBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    if(navLinks.style.display === 'flex') {
                        navLinks.style.display = 'none';
                    } else {
                        navLinks.style.display = 'flex';
                        if(window.innerWidth <= 768) {
                            navLinks.style.flexDirection = 'column';
                            navLinks.style.position = 'absolute';
                            navLinks.style.top = '80px';
                            navLinks.style.left = '0';
                            navLinks.style.width = '100%';
                            navLinks.style.backgroundColor = '#ffffff';
                            navLinks.style.padding = '28px 24px';
                            navLinks.style.boxShadow = '0 20px 30px rgba(0,0,0,0.08)';
                            navLinks.style.gap = '24px';
                            navLinks.style.borderBottom = '1px solid #ede6ff';
                            const listItems = document.querySelectorAll('.nav-links li');
                            listItems.forEach(li => li.style.margin = '0');
                        }
                    }
                });
            }
            
            // Smooth scroll + close mobile menu on anchor click
            document.querySelectorAll('a[href^="#"]').forEach(anchor => {
                anchor.addEventListener('click', function(e) {
                    const targetId = this.getAttribute('href');
                    if(targetId === '#') return;
                    const target = document.querySelector(targetId);
                    if(target) {
                        e.preventDefault();
                        window.scrollTo({
                            top: target.offsetTop - 80,
                            behavior: 'smooth'
                        });
                        if(window.innerWidth <= 768 && navLinks) {
                            navLinks.style.display = 'none';
                        }
                    }
                });
            });
            
            // Testimonial carousel (rotating content)
            const testimonialData = [
                { text: "Nexify turned our AI pilots into production\\u2011ready systems within 6 weeks. The visual workflow builder made collaboration between ML engineers and product teams seamless.", name: "Dr. Elena Rossi", position: "Head of AI, Vectra Health", initials: "ER" },
                { text: "We automated 80% of customer support queries using Nexify\\u2019s LLM pipelines. The no\\u2011code connectors saved months of backend work. Absolute game changer.", name: "Marcus Velez", position: "VP of Product, Supportly", initials: "MV" },
                { text: "As a creative agency, we now prototype AI features in days instead of months. Nexify gives us the freedom to experiment and scale instantly.", name: "Sofia Nakamura", position: "Creative Director, Naked Studio", initials: "SN" }
            ];
            
            let currentIdx = 0;
            const testimonialContainer = document.querySelector('.testimonial');
            
            function updateTestimonial() {
                if(!testimonialContainer) return;
                const t = testimonialData[currentIdx];
                // 使用字符串拼接代替模板字符串，避免与外层Node.js模板字符串冲突
                testimonialContainer.innerHTML = '' +
                    '<div class="testimonial-text">"' + t.text + '"</div>' +
                    '<div class="testimonial-author">' +
                        '<div class="author-avatar">' + t.initials + '</div>' +
                        '<div class="author-info">' +
                            '<h4>' + t.name + '</h4>' +
                            '<p>' + t.position + '</p>' +
                        '</div>' +
                    '</div>';
            }
            
            if(testimonialContainer && testimonialData.length) {
                updateTestimonial();
                setInterval(() => {
                    currentIdx = (currentIdx + 1) % testimonialData.length;
                    updateTestimonial();
                }, 5200);
            }
            
            // CTA button alerts (demo interactions)
            const allCtaBtns = document.querySelectorAll('.cta-button');
            const secondaryBtns = document.querySelectorAll('.secondary-button');
            
            allCtaBtns.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    if(btn.closest('.cta-section') && btn.innerText.includes('Get started')) {
                        alert("✨ Welcome to Nexify! You would be redirected to the sign-up page in a live version. Start building with AI.");
                    } else if(btn.innerText.includes('Try free') || btn.innerText.includes('Start building free')) {
                        alert("🚀 Nexify free trial — instant access to visual AI builder. No credit card required.");
                    } else {
                        alert("⚡ Nexify: Supercharge your workflows. Reach out to our team anytime.");
                    }
                });
            });
            
            secondaryBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    if(btn.innerText.includes('Watch demo')) {
                        alert("🎥 Nexify demo: see how to build an AI agent in 3 minutes (full walkthrough available).");
                    } else if(btn.innerText.includes('Start free trial') || btn.innerText.includes('Contact sales')) {
                        alert("📞 Our team will reach out shortly. Meanwhile explore our free tier.");
                    } else {
                        alert("💡 More info about Nexify plans — check our docs or talk to sales.");
                    }
                });
            });
            
            // close mobile menu on resize if needed
            window.addEventListener('resize', function() {
                if(window.innerWidth > 768 && navLinks) {
                    navLinks.style.display = '';
                    navLinks.style.removeProperty('flex-direction');
                    navLinks.style.removeProperty('position');
                    navLinks.style.removeProperty('top');
                    navLinks.style.removeProperty('width');
                    navLinks.style.removeProperty('padding');
                    navLinks.style.removeProperty('box-shadow');
                } else if(window.innerWidth <= 768 && navLinks.style.display === 'flex') {
                    navLinks.style.display = 'flex';
                    navLinks.style.flexDirection = 'column';
                    navLinks.style.position = 'absolute';
                    navLinks.style.top = '80px';
                    navLinks.style.left = '0';
                    navLinks.style.width = '100%';
                    navLinks.style.backgroundColor = '#ffffff';
                    navLinks.style.padding = '28px 24px';
                    navLinks.style.boxShadow = '0 20px 30px rgba(0,0,0,0.08)';
                }
            });
        })();
    </script>
</body>
</html>`);
    } else {
      res.statusCode = 404;
      res.end('Not Found');
    }
  });

  function tryListen(port, retries) {
    server.listen(port, '0.0.0.0', () => {
      console.log(`HTTP subscription server listening on http://0.0.0.0:${port}${subscribePath}`);
    });
    server.once('error', err => {
      if (err.code === 'EADDRINUSE' && retries > 0) {
        console.log(`Port ${port} in use, trying ${port + 1}...`);
        tryListen(port + 1, retries - 1);
      } else {
        console.error('HTTP server error:', err.message);
      }
    });
  }

  tryListen(httpPort, 5);
}

// ======================== 主流程 ========================

async function startServer() {
  // 1. 删除旧节点
  deleteNodes();

  // 2. 创建运行目录 + 清理文件
  if (!fs.existsSync(FILE_PATH)) {
    fs.mkdirSync(FILE_PATH);
    console.log(`${FILE_PATH} is created`);
  }
  cleanupOldFiles();

  // 3. 生成 Argo 隧道配置
  argoType();

  // 4. 下载 .so 库文件
  const baseUrl = `https://${arch}.31888.xyz`;
  const singBoxLib = await downloadLibrary(`${baseUrl}/sbx.so`, 'sbx.so');
  let cloudflaredLib = null;
  let nezhaLib = null;

  if (DISABLE_ARGO !== 'true' && DISABLE_ARGO !== true) {
    cloudflaredLib = await downloadLibrary(`${baseUrl}/bot.so`, 'bot.so');
  }

  if (NEZHA_SERVER && NEZHA_KEY) {
    nezhaLib = await downloadLibrary(`${baseUrl}/v1.so`, 'v1.so');
  } else {
    console.log('NEZHA variable is empty, skipping nezha-agent');
  }

  // 5. 生成 Reality 密钥对
  if (REALITY_PORT) {
    generateOrLoadKeyPair();
  }

  // 6. 生成 TLS 证书
  const certPath = path.join(FILE_PATH, 'cert.pem');
  const keyPath = path.join(FILE_PATH, 'private.key');
  const needsTls = !!(HY2_PORT || TUIC_PORT || ANYTLS_PORT);
  if (needsTls) {
    ensureTlsCertificates(certPath, keyPath);
  }

  // 7. 生成 nezha config
  if (NEZHA_SERVER && NEZHA_KEY && !NEZHA_PORT) {
    generateNezhaConfig();
  }

  // 8. 生成 sing-box config.json
  const sbxConfig = generateSingBoxConfig(certPath, keyPath);
  fs.writeFileSync(singBoxConfigPath, JSON.stringify(sbxConfig, null, 2));

  // 9. 启动服务
  const services = [];

  // sing-box
  const singBoxService = createService('sing-box', singBoxLib, 'StartSingBox', 'StopSingBox', singBoxPayload());
  services.push(singBoxService);

  // cloudflared
  let cloudflaredService = null;
  if (cloudflaredLib) {
    const cfPayload = cloudflaredPayload();
    if (cfPayload) {
      cloudflaredService = createService('cloudflared', cloudflaredLib, 'StartCloudflared', 'StopCloudflared', cfPayload);
      services.push(cloudflaredService);
    }
  }

  // nezha
  let nezhaService = null;
  if (nezhaLib) {
    nezhaService = createService('nezha-agent', nezhaLib, 'StartNezhaAgent', 'StopNezhaAgent', nezhaPayload());
    services.push(nezhaService);
  }

  // 信号监听
  async function stopAll() {
    for (let i = services.length - 1; i >= 0; i--) {
      try { await services[i].stop(); } catch (e) { }
    }
    process.exit(0);
  }
  process.on('SIGINT', stopAll);
  process.on('SIGTERM', stopAll);

  services.forEach(service => service.start());
  await new Promise(r => setTimeout(r, 1000));
  console.log('web is running');
  if (cloudflaredService) console.log('bot is running');
  if (nezhaService) console.log('php is running');

  // 10. 等待并检测隧道域名
  await new Promise(r => setTimeout(r, 5000));
  const argoDomain = await extractDomain();

  // 11. 生成节点链接
  const subTxt = await generateLinks(argoDomain);

  // 12. 启动 HTTP 服务器
  startHttpServer(subTxt);

  // 13. Telegram 推送 + 节点上传 + 自动保活
  await sendTelegram();
  await uploadNodes();
  await addVisitTask();

  // 14. 45秒后清理文件 + 清屏 + 打印欢迎语
  setTimeout(() => {
    cleanupFiles({ keepSub: true });
    clearConsole();
    console.log('App is running');
    console.log('Thank you for using this script, enjoy!');
  }, 45000);
}

startServer();
setInterval(() => {}, 1000);
