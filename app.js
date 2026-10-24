/* USDT BEP20 transfer. Requires wallet approval for account access and for each transfer. */
const USDT_BEP20 = '0x55d398326f99059fF775485246999027B3197955';
const BSC_CHAIN_ID = '0x38';
const BSC_PARAMS = {
    chainId: BSC_CHAIN_ID, chainName: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: ['https://bsc-dataseed1.binance.org/'],
    blockExplorerUrls: ['https://bscscan.com/']
};
const USDT_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function transfer(address to, uint256 amount) returns (bool)'
];
const ui = {
    recipient: document.getElementById('recipientInput'),
    amount: document.getElementById('amountInput'),
    usdLabel: document.getElementById('usdLabel'),
    balLabel: document.getElementById('balLabel'),
    msg: document.getElementById('msg'),
    nextBtn: document.getElementById('nextBtn'),
    maxBtn: document.getElementById('maxBtn'),
    pasteBtn: document.getElementById('pasteBtn'),
    clearAddr: document.getElementById('clearAddr'),
    clearAmount: document.getElementById('clearAmount'),
    addrGroup: document.getElementById('addrGroup'),
    amountGroup: document.getElementById('amountGroup')
};
let provider = null;
let userAddress = null;
let balanceWei = null;
let tokenDecimals = 18;
let busy = false;

function setMsg(message, kind = 'err', hash = null) {
    ui.msg.className = 'msg' + (kind === 'ok' ? ' ok' : '');
    ui.msg.textContent = message;
    if (hash) {
        ui.msg.append(' ');
        const a = document.createElement('a');
        a.href = `https://bscscan.com/tx/${hash}`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'View on BscScan';
        ui.msg.append(a);
    }
}
function clearMsg() { ui.msg.textContent = ''; ui.msg.className = 'msg'; }
function formatError(err) {
    if (err?.code === 4001 || err?.code === 'ACTION_REJECTED') return 'You rejected the wallet request.';
    if (err?.code === 4100) return 'Wallet account access not authorized. Please approve the connection.';
    if (err?.code === -32002) return 'A wallet approval request is already pending. Please open your wallet.';
    if (err?.code === 'INSUFFICIENT_FUNDS') return 'Not enough BNB to cover network gas.';
    if (err?.code === 'UNPREDICTABLE_GAS_LIMIT' || err?.code === 'CALL_EXCEPTION') return 'Transfer could not be estimated. Check your USDT balance and gas.';
    return err?.reason || err?.data?.message || err?.message || 'Something went wrong.';
}
function parseAmount() {
    const raw = ui.amount.value.trim();
    if (!/^\d*\.?\d+$/.test(raw)) throw new Error('Invalid amount');
    const wei = ethers.utils.parseUnits(raw, tokenDecimals);
    if (wei.lte(0)) throw new Error('Amount must be positive');
    return wei;
}
function refreshValidation() {
    const addressValid = ethers.utils.isAddress(ui.recipient.value.trim());
    let amountValid = false;
    try { parseAmount(); amountValid = true; } catch {}
    ui.addrGroup.classList.toggle('invalid', !!ui.recipient.value.trim() && !addressValid);
    ui.amountGroup.classList.toggle('invalid', !!ui.amount.value.trim() && !amountValid);
    ui.clearAddr.style.display = ui.recipient.value ? 'flex' : 'none';
    ui.clearAmount.style.display = ui.amount.value ? 'flex' : 'none';
    const numeric = Number(ui.amount.value);
    ui.usdLabel.textContent = Number.isFinite(numeric) ? numeric.toFixed(2) : '0.00';
    const valid = addressValid && amountValid && !busy;
    ui.nextBtn.disabled = !valid;
    ui.nextBtn.classList.toggle('enabled', valid);
}
function setBusy(value, label = 'Next') {
    busy = value;
    ui.nextBtn.textContent = label;
    refreshValidation();
}
async function switchToBsc() {
    const current = await window.ethereum.request({ method: 'eth_chainId' });
    if (String(current).toLowerCase() === BSC_CHAIN_ID) return;
    try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BSC_CHAIN_ID }] });
    } catch (err) {
        if (err.code !== 4902) throw err;
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [BSC_PARAMS] });
        const chain = await window.ethereum.request({ method: 'eth_chainId' });
        if (String(chain).toLowerCase() !== BSC_CHAIN_ID) {
            await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BSC_CHAIN_ID }] });
        }
    }
    const actual = await window.ethereum.request({ method: 'eth_chainId' });
    if (String(actual).toLowerCase() !== BSC_CHAIN_ID) throw new Error('Select BNB Smart Chain in your wallet.');
}
async function connectWallet() {
    if (!window.ethereum) throw new Error('Wallet not detected. Open this page inside your wallet browser or install an EVM wallet.');
    // Explicitly ask for accounts; getSigner() before this caused "unknown account #0".
    let accounts = await window.ethereum.request({ method: 'eth_accounts' });
    if (!accounts?.length) {
        accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    }
    if (!accounts?.length) throw new Error('No wallet account selected.');
    await switchToBsc();
    const approved = await window.ethereum.request({ method: 'eth_accounts' });
    if (!approved?.length) throw new Error('No authorized wallet account found.');
    userAddress = ethers.utils.getAddress(approved[0]);
    provider = new ethers.providers.Web3Provider(window.ethereum, 'any');
    return provider.getSigner(userAddress);
}
async function refreshBalance() {
    balanceWei = null;
    if (!userAddress || !provider) { ui.balLabel.textContent = '—'; return; }
    try {
        const read = new ethers.Contract(USDT_BEP20, USDT_ABI, provider);
        const [balance, decimals] = await Promise.all([read.balanceOf(userAddress), read.decimals()]);
        tokenDecimals = Number(decimals);
        balanceWei = balance;
        ui.balLabel.textContent = Number(ethers.utils.formatUnits(balance, tokenDecimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });
    } catch (err) {
        ui.balLabel.textContent = '—';
        console.warn('Balance read failed:', err);
    }
    refreshValidation();
}
// One Next button: request account permission only if it has never been granted.
// Every blockchain transfer still requires the wallet's own transaction approval.
async function handleNextClick() {
    if (busy || ui.nextBtn.disabled) return;
    clearMsg();
    setBusy(true, 'Opening wallet…');
    try {
        const signer = await connectWallet();
        const recipient = ethers.utils.getAddress(ui.recipient.value.trim());
        const amount = parseAmount();
        if (recipient.toLowerCase() === userAddress.toLowerCase()) {
            throw new Error('Recipient and sender addresses are identical.');
        }
        await refreshBalance();
        if (balanceWei === null) throw new Error('Could not verify USDT balance. Try again.');
        if (amount.gt(balanceWei)) throw new Error('Amount exceeds your available USDT balance.');
        // Recipient and amount are shown on the page before Next is pressed.
        // The wallet independently requests explicit approval for this transfer.
        const contract = new ethers.Contract(USDT_BEP20, USDT_ABI, signer);
        const tx = await contract.transfer(recipient, amount);
        setMsg('Transaction submitted.', 'ok', tx.hash);
        setBusy(true, 'Sending…');
        const receipt = await tx.wait(1);
        if (receipt.status !== 1) throw new Error('Transaction reverted on-chain.');
        setMsg('Transfer confirmed.', 'ok', tx.hash);
        ui.amount.value = '';
        await refreshBalance();
    } catch (err) {
        console.error(err);
        setMsg(formatError(err));
    } finally {
        setBusy(false);
    }
}
function sanitizeAmountInput() {
    let value = ui.amount.value.replace(/[^\d.]/g, '');
    const firstDot = value.indexOf('.');
    if (firstDot >= 0) {
        value = value.slice(0, firstDot + 1) + value.slice(firstDot + 1).replace(/\./g, '');
        const [whole, fractional = ''] = value.split('.');
        value = whole + '.' + fractional.slice(0, tokenDecimals);
    }
    ui.amount.value = value;
}
async function boot() {
    ui.recipient.addEventListener('input', refreshValidation);
    ui.amount.addEventListener('input', () => { sanitizeAmountInput(); refreshValidation(); });
    ui.clearAddr.addEventListener('click', () => { ui.recipient.value = ''; refreshValidation(); });
    ui.clearAmount.addEventListener('click', () => { ui.amount.value = ''; refreshValidation(); });
    ui.pasteBtn.addEventListener('click', async () => {
        try { ui.recipient.value = (await navigator.clipboard.readText()).trim(); refreshValidation(); }
        catch { setMsg('Clipboard permission denied. Paste manually.'); }
    });
    ui.maxBtn.addEventListener('click', async () => {
        if (balanceWei === null) {
            setMsg('Tap Next to connect your wallet and load your balance first.');
            return;
        }
        ui.amount.value = ethers.utils.formatUnits(balanceWei, tokenDecimals);
        refreshValidation();
    });
    ui.nextBtn.addEventListener('click', handleNextClick);
    if (typeof ethers === 'undefined') { setMsg('Failed to load ethers.js. Check your internet connection.'); ui.nextBtn.disabled = true; return; }
    if (!window.ethereum) {
        setMsg('No wallet detected. Open this page in a wallet browser or install an EVM wallet.');
        ui.nextBtn.disabled = true;
        return;
    }
    // No wallet pop-up on load. Read already-authorized accounts only.
    try {
        const accounts = await window.ethereum.request({ method: 'eth_accounts' });
        const chain = await window.ethereum.request({ method: 'eth_chainId' });
        if (accounts?.length && String(chain).toLowerCase() === BSC_CHAIN_ID) {
            userAddress = ethers.utils.getAddress(accounts[0]);
            provider = new ethers.providers.Web3Provider(window.ethereum, 'any');
            await refreshBalance();
        }
    } catch (err) { console.warn('Silent account read failed:', err); }
    refreshValidation();
    window.ethereum.on?.('accountsChanged', async accounts => {
        userAddress = accounts?.length ? ethers.utils.getAddress(accounts[0]) : null;
        provider = userAddress ? new ethers.providers.Web3Provider(window.ethereum, 'any') : null;
        await refreshBalance();
    });
    window.ethereum.on?.('chainChanged', async () => {
        balanceWei = null;
        ui.balLabel.textContent = '—';
        const chain = await window.ethereum.request({ method: 'eth_chainId' });
        if (String(chain).toLowerCase() === BSC_CHAIN_ID && userAddress) {
            provider = new ethers.providers.Web3Provider(window.ethereum, 'any');
            await refreshBalance();
        }
    });
}
boot();
