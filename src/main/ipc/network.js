// 网络策略与连通性诊断 IPC（从 main/index.js 抽离）
// 全部为 networkPolicyService 的薄封装：策略读写、各服务连通性探测、
// TUN 模式检测、完整诊断报告与域名建议。

function registerNetworkIpc({ handle, networkPolicyService }) {
    handle('network-policy-get', async () => {
        return {
            policies: networkPolicyService.policies,
            proxyUrl: networkPolicyService.proxyUrl,
            serviceIds: Object.values(networkPolicyService.constructor.SERVICE_IDS),
            policyModes: Object.values(networkPolicyService.constructor.POLICY_MODES),
            domainSuggestions: networkPolicyService.getDomainSuggestions()
        };
    });

    handle('network-policy-update', async (event, policies = {}) => {
        networkPolicyService.setPolicies(policies);
        return { success: true, policies: networkPolicyService.policies };
    });

    handle('network-test-proxy-port', async () => {
        return networkPolicyService.testProxyPort();
    });

    handle('network-test-bangumi', async () => {
        return networkPolicyService.testBangumi();
    });

    handle('network-test-playback-source', async () => {
        return networkPolicyService.testPlaybackSource();
    });

    handle('network-test-danmaku', async () => {
        return networkPolicyService.testDanmaku();
    });

    handle('network-test-trace-moe', async () => {
        return networkPolicyService.testTraceMoe();
    });

    handle('network-test-m3u8', async (event, url, referer = '') => {
        return networkPolicyService.testM3u8(url, referer);
    });

    handle('network-detect-tun', async () => {
        return networkPolicyService.detectTunMode();
    });

    handle('network-run-diagnostics', async () => {
        return networkPolicyService.runFullDiagnostics();
    });

    handle('network-domain-suggestions', async () => {
        return networkPolicyService.getDomainSuggestions();
    });
}

module.exports = { registerNetworkIpc };