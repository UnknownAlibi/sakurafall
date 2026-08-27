/**
 * DLNA 投屏服务
 *
 * 功能：
 *   1. 通过 SSDP（简单服务发现协议）搜索局域网内的 DLNA/UPnP 设备
 *   2. 解析设备描述 XML 获取 friendlyName 和 AVTransport 控制地址
 *   3. 通过 SOAP 控制 DLNA 设备：SetAVTransportURI（播放）、Pause、Stop、Seek
 *   4. 启动本地 HTTP 代理服务器，让 DLNA 设备能访问到视频流
 *      （原始 URL 可能是 https 或需要 Referer 等 header，DLNA 设备无法直接访问）
 *
 * 纯 Node.js 实现，不引入额外 npm 包。
 *
 * 设备数据结构：
 *   { id, name, location, controlUrl, serviceType }
 *
 * 投屏后通过 getPosition 可定时获取播放位置同步 UI。
 */

const dgram = require('dgram');
const http = require('http');
const https = require('https');
const os = require('os');

// SSDP 多播地址端口
const SSDP_MULTICAST_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

// 本地代理服务器默认端口
const DEFAULT_PROXY_PORT = 8321;

// AVTransport 服务类型（DLNA 标准服务）
const AV_TRANSPORT_SERVICE_TYPE = 'urn:schemas-upnp-org:service:AVTransport:1';

// 拼接 URL（base + relative，处理相对路径）
function resolveUrl(base, relative) {
    if (!relative) return base;
    try {
        return new URL(relative, base).toString();
    } catch (e) {
        // URL 解析失败时退回简单拼接
        if (/^https?:\/\//i.test(relative)) return relative;
        return base.replace(/\/+$/, '') + '/' + String(relative).replace(/^\/+/, '');
    }
}

// 安全日志（防止 EPIPE）
function safeLog(...args) {
    try { console.log(...args); } catch (e) { /* ignore */ }
}
function safeError(...args) {
    try { console.error(...args); } catch (e) { /* ignore */ }
}

/**
 * 极简 XML 提取：从文本中取出指定标签内容（不依赖 DOM 解析库）
 * 仅用于解析设备描述 XML 中的 friendlyName、controlURL 等简单字段
 */
function extractXmlTag(xml, tag) {
    if (!xml || !tag) return '';
    // 优先匹配带命名空间的标签 <tag>xxx</tag>
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = xml.match(re);
    return match ? match[1].trim() : '';
}

// 把秒数格式化为 DLNA Seek 模式所需的 HH:MM:SS 字符串
function secondsToHms(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

// 把 HH:MM:SS 字符串解析回秒数
function hmsToSeconds(str) {
    if (!str || typeof str !== 'string') return 0;
    const parts = str.trim().split(':').map(p => parseFloat(p) || 0);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
}

// 从 SOAP 响应 XML 中提取某个字段的值
function extractSoapValue(xml, tag) {
    if (!xml) return '';
    // SOAP 响应字段通常带前缀，如 <u:GetPositionInfoResponse><Track>0</Track>...
    // 这里宽松匹配标签名
    const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${tag}>`, 'i');
    const match = xml.match(re);
    return match ? match[1].trim() : '';
}

/**
 * 获取本机内网 IPv4 地址（非内网回环）
 * 用于构造 DLNA 设备能访问的本地代理 URL
 */
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        const list = interfaces[name];
        if (!list) continue;
        for (const item of list) {
            if (item.family === 'IPv4' && !item.internal) {
                return item.address;
            }
        }
    }
    return '127.0.0.1';
}

class DlnaService {
    constructor(options = {}) {
        this.proxyPort = parseInt(options.proxyPort, 10) || DEFAULT_PROXY_PORT;
        // 本地代理服务器实例
        this._proxyServer = null;
        // 当前代理的目标视频信息：{ url, headers, title, mime }
        this._currentProxyTarget = null;
        // 当前选中的设备 id（用于getPosition等无 deviceId 参数的便捷调用）
        this._activeDeviceId = null;
        // 已发现的设备缓存：id -> device info
        this._devices = new Map();
        // SSDP 搜索 socket（复用，搜索时打开，搜完关闭）
        this._ssdpSocket = null;
    }

    // ============================================================
    // 本地代理服务器
    // ============================================================

    /**
     * 启动本地代理 HTTP 服务器
     * 设备访问 http://<本机IP>:<port>/stream 时，转发到原始视频 URL
     */
    startProxyServer() {
        if (this._proxyServer) return this.proxyPort;
        const server = http.createServer((req, res) => this._handleProxyRequest(req, res));
        this._proxyServer = server;
        return new Promise((resolve, reject) => {
            server.on('error', (err) => {
                safeError('[DLNA] 代理服务器启动失败:', err.message);
                this._proxyServer = null;
                reject(err);
            });
            server.listen(this.proxyPort, '0.0.0.0', () => {
                const addr = server.address();
                this.proxyPort = addr && typeof addr === 'object' ? addr.port : this.proxyPort;
                safeLog(`[DLNA] 代理服务器已启动，端口 ${this.proxyPort}`);
                resolve(this.proxyPort);
            });
        });
    }

    stopProxyServer() {
        if (this._proxyServer) {
            try { this._proxyServer.close(); } catch (e) { /* ignore */ }
            this._proxyServer = null;
            this._currentProxyTarget = null;
            safeLog('[DLNA] 代理服务器已停止');
        }
    }

    /**
     * 设置当前代理目标
     * @param {Object} target - { url, headers?, title?, mime? }
     */
    setProxyTarget(target) {
        this._currentProxyTarget = target || null;
    }

    /**
     * 获取代理服务器对外可访问的流 URL
     * 设备通过此 URL 拉取视频流
     */
    getProxyStreamUrl() {
        if (!this._proxyServer) return '';
        const ip = getLocalIpAddress();
        return `http://${ip}:${this.proxyPort}/stream`;
    }

    _handleProxyRequest(req, res) {
        const target = this._currentProxyTarget;
        if (!target || !target.url) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('No proxy target');
            return;
        }

        // 处理 CORS（部分设备会发 OPTIONS 预检）
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // 解析原始 URL
        let parsed;
        try {
            parsed = new URL(target.url);
        } catch (e) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Invalid target URL');
            return;
        }

        const lib = parsed.protocol === 'https:' ? https : http;

        // 转发 Range 请求头（DLNA 设备通常会用 Range 分段请求）
        const forwardHeaders = {};
        if (req.headers['range']) {
            forwardHeaders['Range'] = req.headers['range'];
        }
        if (req.headers['user-agent']) {
            forwardHeaders['User-Agent'] = req.headers['user-agent'];
        }
        // 合并调用方指定的 header（如 Referer、Origin 等）
        if (target.headers && typeof target.headers === 'object') {
            Object.assign(forwardHeaders, target.headers);
        }
        if (!forwardHeaders['User-Agent']) {
            forwardHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
        }

        const options = {
            method: 'GET',
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            headers: forwardHeaders
        };

        const upstream = lib.request(options, (upstreamRes) => {
            // 转发状态码和关键响应头
            const status = upstreamRes.statusCode || 200;
            const respHeaders = {
                'Access-Control-Allow-Origin': '*'
            };
            const passThroughHeaders = [
                'content-type', 'content-length', 'content-range',
                'accept-ranges', 'content-disposition'
            ];
            for (const h of passThroughHeaders) {
                if (upstreamRes.headers[h]) {
                    respHeaders[h] = upstreamRes.headers[h];
                }
            }
            // 兜底：如果原始响应没带 content-type 但调用方指定了，用调用方的
            if (!respHeaders['content-type'] && target.mime) {
                respHeaders['content-type'] = target.mime;
            }
            res.writeHead(status, respHeaders);
            upstreamRes.pipe(res);
        });

        upstream.on('error', (err) => {
            safeError('[DLNA] 代理转发失败:', err.message);
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Proxy error: ' + err.message);
            } else {
                try { res.destroy(); } catch (e) { /* ignore */ }
            }
        });

        req.on('close', () => {
            try { upstream.destroy(); } catch (e) { /* ignore */ }
        });

        upstream.end();
    }

    // ============================================================
    // SSDP 设备发现
    // ============================================================

    /**
     * 搜索局域网内的 DLNA 设备
     * @param {Object} options - { timeout?: 搜索超时毫秒，默认 5000 }
     * @returns {Promise<Array<{id, name, location, controlUrl}>>}
     */
    async discoverDevices(options = {}) {
        const timeout = Math.max(1000, parseInt(options.timeout, 10) || 5000);
        const seenLocations = new Set();
        const devices = [];

        // 关闭旧 socket
        this._closeSsdpSocket();

        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        this._ssdpSocket = socket;

        // 构造 SSDP M-SEARCH 报文
        const message = [
            'M-SEARCH * HTTP/1.1',
            `HOST: ${SSDP_MULTICAST_ADDR}:${SSDP_PORT}`,
            'MAN: "ssdp:discover"',
            'MX: 3',
            'ST: urn:schemas-upnp-org:service:AVTransport:1',
            '',
            ''
        ].join('\r\n');

        const multicast = () => {
            try {
                socket.send(message, 0, message.length, SSDP_PORT, SSDP_MULTICAST_ADDR);
            } catch (e) {
                safeError('[DLNA] SSDP 发送失败:', e.message);
            }
        };

        return new Promise((resolve) => {
            let settled = false;

            const finish = () => {
                if (settled) return;
                settled = true;
                this._closeSsdpSocket();
                resolve(devices);
            };

            const timer = setTimeout(finish, timeout);

            socket.on('error', (err) => {
                safeError('[DLNA] SSDP socket 错误:', err.message);
                clearTimeout(timer);
                finish();
            });

            socket.on('message', (msg, _rinfo) => {
                const text = msg.toString();
                // 解析 HTTP 头：LOCATION: http://...
                const locationMatch = text.match(/^LOCATION:\s*(.+)$/mi);
                if (!locationMatch) return;
                const location = locationMatch[1].trim();
                if (seenLocations.has(location)) return;
                seenLocations.add(location);

                // 异步获取设备描述，避免阻塞 SSDP 接收
                this._fetchDeviceDescription(location)
                    .then((info) => {
                        if (!info || !info.controlUrl) return;
                        const device = {
                            id: location,
                            name: info.name || 'DLNA 设备',
                            location,
                            controlUrl: info.controlUrl
                        };
                        // 去重：相同 location 视为同一设备
                        const exists = devices.find(d => d.id === device.id);
                        if (!exists) {
                            devices.push(device);
                            this._devices.set(device.id, device);
                        }
                    })
                    .catch((err) => {
                        safeError('[DLNA] 获取设备描述失败:', location, err.message);
                    });
            });

            socket.bind(() => {
                // 设置多播 TTL
                try { socket.setMulticastTTL(4); } catch (e) { /* ignore */ }
                multicast();
                // MX 秒后再发一次，提高响应率
                setTimeout(multicast, 800);
            });
        });
    }

    _closeSsdpSocket() {
        if (this._ssdpSocket) {
            try { this._ssdpSocket.close(); } catch (e) { /* ignore */ }
            this._ssdpSocket = null;
        }
    }

    /**
     * 获取设备描述 XML，解析出 friendlyName 和 AVTransport controlUrl
     */
    async _fetchDeviceDescription(location) {
        return new Promise((resolve, reject) => {
            let parsed;
            try {
                parsed = new URL(location);
            } catch (e) {
                reject(new Error('Invalid location URL'));
                return;
            }

            const lib = parsed.protocol === 'https:' ? https : http;
            const req = lib.get(location, {
                timeout: 5000,
                headers: { 'User-Agent': 'Mozilla/5.0 SakuraFall DLNA' }
            }, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    res.resume();
                    return;
                }
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const xml = Buffer.concat(chunks).toString('utf8');
                    try {
                        resolve(this._parseDeviceDescription(xml, location));
                    } catch (err) {
                        reject(err);
                    }
                });
                res.on('error', reject);
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy(new Error('timeout'));
            });
        });
    }

    /**
     * 从设备描述 XML 解析 friendlyName + AVTransport 控制地址
     * 设备描述结构：
     *   <root>
     *     <device>
     *       <friendlyName>xxx</friendlyName>
     *       <serviceList>
     *         <service>
     *           <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
     *           <controlURL>/upnp/control/AVTransport</controlURL>
     *         </service>
     *       </serviceList>
     *     </device>
     *   </root>
     */
    _parseDeviceDescription(xml, location) {
        const name = extractXmlTag(xml, 'friendlyName') || 'DLNA 设备';
        // 找到 AVTransport service 节点
        // 由于 serviceList 可能含多个 service，需要先定位 serviceType 为 AVTransport 的 service 块
        const serviceBlocks = this._extractServiceBlocks(xml);
        let controlPath = '';
        for (const block of serviceBlocks) {
            const serviceType = extractXmlTag(block, 'serviceType');
            if (serviceType === AV_TRANSPORT_SERVICE_TYPE) {
                controlPath = extractXmlTag(block, 'controlURL');
                break;
            }
        }
        if (!controlPath) {
            return { name, controlUrl: '' };
        }
        const controlUrl = resolveUrl(location, controlPath);
        return { name, controlUrl };
    }

    /**
     * 从设备描述 XML 提取所有 <service>...</service> 块
     */
    _extractServiceBlocks(xml) {
        const blocks = [];
        const re = /<service\b[\s\S]*?<\/service>/gi;
        let match;
        while ((match = re.exec(xml)) !== null) {
            blocks.push(match[0]);
        }
        return blocks;
    }

    // ============================================================
    // SOAP 控制
    // ============================================================

    /**
     * 发送 SOAP 请求到 DLNA 设备的 AVTransport 控制地址
     * @param {string} controlUrl - 设备控制 URL
     * @param {string} action - SOAP action 名（如 'SetAVTransportURI'）
     * @param {string} bodyInner - SOAP body 内部 XML（不含 envelope）
     * @returns {Promise<string>} 响应体 XML
     */
    _sendSoapRequest(controlUrl, action, bodyInner) {
        return new Promise((resolve, reject) => {
            if (!controlUrl) {
                reject(new Error('设备控制地址为空'));
                return;
            }
            let parsed;
            try {
                parsed = new URL(controlUrl);
            } catch (e) {
                reject(new Error('设备控制地址无效'));
                return;
            }

            const soapAction = `"${AV_TRANSPORT_SERVICE_TYPE}#${action}"`;
            const body = `<?xml version="1.0" encoding="utf-8"?>` +
                `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
                `<s:Body>` +
                `<u:${action} xmlns:u="${AV_TRANSPORT_SERVICE_TYPE}">` +
                bodyInner +
                `</u:${action}>` +
                `</s:Body>` +
                `</s:Envelope>`;

            const headers = {
                'Content-Type': 'text/xml; charset="utf-8"',
                'SOAPAction': soapAction,
                'User-Agent': 'Mozilla/5.0 SakuraFall DLNA',
                'Content-Length': Buffer.byteLength(body),
                'Connection': 'close'
            };

            const lib = parsed.protocol === 'https:' ? https : http;
            const options = {
                method: 'POST',
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                headers,
                timeout: 8000
            };

            const req = lib.request(options, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    // SOAP 错误响应通常状态码 500，且 body 含 <errorCode>/<errorDescription>
                    if (res.statusCode >= 400) {
                        const errCode = extractSoapValue(text, 'errorCode');
                        const errDesc = extractSoapValue(text, 'errorDescription');
                        reject(new Error(`SOAP 调用失败 (${res.statusCode}): ${errCode} ${errDesc}`.trim()));
                    } else {
                        resolve(text);
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy(new Error('SOAP 请求超时'));
            });
            req.write(body);
            req.end();
        });
    }

    /**
     * 根据设备 id 查找设备信息
     */
    _findDevice(deviceId) {
        // 先从缓存查
        if (this._devices.has(deviceId)) {
            return this._devices.get(deviceId);
        }
        // 兜底：直接用 deviceId 作为 controlUrl（允许调用方直接传 controlUrl）
        if (/^https?:\/\//i.test(deviceId)) {
            return { id: deviceId, name: 'DLNA 设备', location: '', controlUrl: deviceId };
        }
        return null;
    }

    /**
     * 投屏播放：先 SetAVTransportURI 设置 URL，再 Play
     * @param {string} deviceId - 设备 id（discoverDevices 返回的 id）
     * @param {string} videoUrl - 视频流 URL（如果需要代理，应传代理 URL）
     * @param {string} [title] - 视频标题（投屏时显示）
     */
    async cast(deviceId, videoUrl, title) {
        const device = this._findDevice(deviceId);
        if (!device) throw new Error('未找到指定的 DLNA 设备');

        const safeTitle = String(title || '视频').replace(/[<>&'"]/g, '');
        // DIDL-Lite 元数据：让设备显示标题
        const meta =
            `<CurrentURI>${videoUrl.replace(/[<>&'"]/g, '')}</CurrentURI>` +
            `<CurrentURIMetaData>` +
            `&lt;DIDL-Lite xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot;` +
            ` xmlns:dc=&quot;http://purl.org/dc/elements/1.1/&quot;` +
            ` xmlns:upnp=&quot;urn:schemas-upnp-org:metadata-1-0/upnp/&quot;&gt;` +
            `&lt;item id=&quot;1&quot; parentID=&quot;0&quot; restricted=&quot;1&quot;&gt;` +
            `&lt;dc:title&gt;${safeTitle}&lt;/dc:title&gt;` +
            `&lt;upnp:class&gt;object.item.videoItem&lt;/upnp:class&gt;` +
            `&lt;/item&gt;` +
            `&lt;/DIDL-Lite&gt;` +
            `</CurrentURIMetaData>`;

        // 第一步：SetAVTransportURI
        await this._sendSoapRequest(device.controlUrl, 'SetAVTransportURI',
            `<InstanceID>0</InstanceID>` + meta
        );

        // 第二步：Play
        await this._sendSoapRequest(device.controlUrl, 'Play',
            `<InstanceID>0</InstanceID><Speed>1</Speed>`
        );

        this._activeDeviceId = deviceId;
        return { success: true };
    }

    /**
     * 暂停投屏播放
     */
    async pause(deviceId) {
        const id = deviceId || this._activeDeviceId;
        const device = this._findDevice(id);
        if (!device) throw new Error('未找到指定的 DLNA 设备');
        await this._sendSoapRequest(device.controlUrl, 'Pause', `<InstanceID>0</InstanceID>`);
        return { success: true };
    }

    /**
     * 恢复投屏播放（DLNA 没有 Resume，用 Play）
     */
    async resume(deviceId) {
        const id = deviceId || this._activeDeviceId;
        const device = this._findDevice(id);
        if (!device) throw new Error('未找到指定的 DLNA 设备');
        await this._sendSoapRequest(device.controlUrl, 'Play',
            `<InstanceID>0</InstanceID><Speed>1</Speed>`
        );
        return { success: true };
    }

    /**
     * 停止投屏
     */
    async stop(deviceId) {
        const id = deviceId || this._activeDeviceId;
        const device = this._findDevice(id);
        if (!device) throw new Error('未找到指定的 DLNA 设备');
        await this._sendSoapRequest(device.controlUrl, 'Stop', `<InstanceID>0</InstanceID>`);
        if (deviceId === this._activeDeviceId || !deviceId) {
            this._activeDeviceId = null;
        }
        return { success: true };
    }

    /**
     * 跳转到指定秒数
     * @param {string} deviceId
     * @param {number} seconds - 目标秒数
     */
    async seek(deviceId, seconds) {
        const id = deviceId || this._activeDeviceId;
        const device = this._findDevice(id);
        if (!device) throw new Error('未找到指定的 DLNA 设备');
        const target = secondsToHms(seconds);
        // DLNA Seek 单位：REL_TIME 表示相对时间
        await this._sendSoapRequest(device.controlUrl, 'Seek',
            `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${target}</Target>`
        );
        return { success: true };
    }

    /**
     * 获取当前播放位置和媒体总时长
     * @returns {Promise<{ position: number, duration: number }>} 单位：秒
     */
    async getPosition(deviceId) {
        const id = deviceId || this._activeDeviceId;
        const device = this._findDevice(id);
        if (!device) throw new Error('未找到指定的 DLNA 设备');
        const xml = await this._sendSoapRequest(device.controlUrl, 'GetPositionInfo',
            `<InstanceID>0</InstanceID>`
        );
        const relTime = extractSoapValue(xml, 'RelTime');
        const trackDuration = extractSoapValue(xml, 'TrackDuration');
        return {
            position: hmsToSeconds(relTime),
            duration: hmsToSeconds(trackDuration)
        };
    }

    // 清理资源
    shutdown() {
        this._closeSsdpSocket();
        this.stopProxyServer();
        this._devices.clear();
        this._activeDeviceId = null;
    }
}

// 导出单例
const dlnaService = new DlnaService();
module.exports = dlnaService;
module.exports.DlnaService = DlnaService;
module.exports.resolveUrl = resolveUrl;
module.exports.secondsToHms = secondsToHms;
module.exports.hmsToSeconds = hmsToSeconds;
