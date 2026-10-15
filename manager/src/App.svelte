<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';

  type Status = { running: boolean; ready: boolean; tunnel_id: string; organization_id: string; has_key: boolean; runtime_ready: boolean; runtime_message: string; connection_issue: string | null };
  let status = $state<Status>({ running: false, ready: false, tunnel_id: '', organization_id: '', has_key: false, runtime_ready: false, runtime_message: '', connection_issue: null });
  let modal = $state<'none' | 'settings' | 'exit' | 'restart'>('none');
  let working = $state(false);
  type LogLevel = 'info' | 'success' | 'warning' | 'error';
  type LogEntry = { id: number; time: string; level: LogLevel; message: string };
  let entries = $state<LogEntry[]>([]);
  let logScroll: HTMLDivElement;
  let nextLogID = 0;
  let previousState: 'ready' | 'starting' | 'stopped' | 'error' | null = null;
  let previousIssue = '';
  let previousRuntimeReady: boolean | null = null;
  let previousRefreshError = '';
  let newTunnelID = $state('');
  let newOrganizationID = $state('');
  let newKey = $state('');

  const icons: Record<string,string> = {
    restart: 'M20 7v5h-5M4 17v-5h5M5.5 9A7.5 7.5 0 0 1 18.5 7M18.5 15A7.5 7.5 0 0 1 5.5 17',
    power: 'M12 2v10M6.3 5.5a9 9 0 1 0 11.4 0',
    unplug: 'M8 3v5M16 3v5M6 8h12v4a6 6 0 0 1-6 6v3',
    settings: 'M4 7h16M4 17h16M9 5v4M16 15v4'
  };
  function addLog(level: LogLevel, message: string) {
    const nearBottom = !logScroll || logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < 32;
    entries = [...entries.slice(-149), { id: ++nextLogID, time: new Date().toLocaleTimeString('ko-KR', { hour12: false }), level, message }];
    if (nearBottom) void tick().then(() => { if (logScroll) logScroll.scrollTop = logScroll.scrollHeight; });
  }
  async function refresh() {
    const next = await invoke<Status>('get_status');
    const currentState = next.connection_issue ? 'error' : next.ready ? 'ready' : next.running ? 'starting' : 'stopped';
    if (currentState !== previousState) {
      if (currentState === 'ready') addLog('success', '터널 연결이 준비되었습니다.');
      else if (currentState === 'starting') addLog('info', '터널 연결을 확인 중입니다.');
      else if (currentState === 'stopped') addLog('warning', '터널이 연결되지 않았습니다.');
      previousState = currentState;
    }
    if (next.connection_issue && next.connection_issue !== previousIssue) addLog('error', next.connection_issue);
    previousIssue = next.connection_issue ?? '';
    if (!next.runtime_ready && previousRuntimeReady !== false) {
      addLog('error', next.runtime_message || 'Desktop Commander 실행 리소스를 찾을 수 없습니다.');
    }
    previousRuntimeReady = next.runtime_ready;
    previousRefreshError = '';
    status = next;
  }
  async function refreshSafely() {
    try { await refresh(); }
    catch (e) {
      const message = String(e);
      if (previousRefreshError !== message) addLog('error', '상태 확인 실패: ' + message);
      previousRefreshError = message;
    }
  }
  onMount(() => {
    addLog('info', 'Manager 실행. 연결 상태를 확인합니다.');
    void refreshSafely();
    const clock = setInterval(() => { void refreshSafely(); }, 2500);
    return () => clearInterval(clock);
  });
  async function execute(action: () => Promise<unknown>, success = '', level: LogLevel = 'info') {
    working = true;
    try {
      await action();
      if (success) addLog(level, success);
      await refreshSafely();
    } catch (e) { addLog('error', String(e)); }
    finally { working = false; }
  }
  function openSettings() { newTunnelID = status.tunnel_id; newOrganizationID = status.organization_id; newKey = ''; modal = 'settings'; }
</script>

<svelte:head><title>Desktop Commander Manager</title></svelte:head>
<div class="shell">
  <header class="top">
    <div class="logo">›_</div>
    <div class="grow"><div class="name">Desktop Commander</div><div class="sub">Remote manager</div></div>
    <div class:up={status.ready} class:failed={Boolean(status.connection_issue)} class="status"><span class="dot"></span>{status.connection_issue ? 'Error' : status.ready ? 'Ready' : status.running ? 'Starting' : 'Stopped'}</div>
  </header>
  <main class="content">
    <div class="actions">
      <button class="btn" disabled={working} onclick={() => execute(() => invoke(status.running ? 'disconnect_tunnel' : 'connect_tunnel'), status.running ? '터널 연결을 해제했습니다.' : '터널 실행을 시작했습니다.', status.running ? 'warning' : 'info')}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d={icons.unplug}/></svg>
        {status.running ? 'Disconnect' : 'Connect'}
      </button>
      <button class="btn" disabled={working || !status.running} onclick={() => modal = 'restart'}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d={icons.restart}/></svg>Restart DC
      </button>
    </div>
    <div class="divider"></div>
    <section class="activity-panel" aria-label="Activity log">
      <div class="activity-head">
        <strong>Activity log</strong><span class="activity-count">{entries.length} / 150</span>
      </div>
      <div class="activity-scroll" bind:this={logScroll} role="log" aria-live="polite" aria-relevant="additions" aria-label="Connection and application events">
        {#each entries as entry (entry.id)}
          <div class="log-entry" class:info={entry.level === 'info'} class:success={entry.level === 'success'} class:warning={entry.level === 'warning'} class:error={entry.level === 'error'}>
            <div class="log-meta">
              <span class="log-level">{entry.level === 'success' ? 'OK' : entry.level.toUpperCase()}</span>
              <time class="log-time">{entry.time}</time>
            </div>
            <div class="log-message">{entry.message}</div>
          </div>
        {/each}
      </div>
    </section>
    <div class="bottom">
      <button onclick={openSettings}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d={icons.settings}/></svg>Connection settings</button>
      <button onclick={() => modal = 'exit'}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d={icons.power}/></svg>Exit</button>
    </div>
  </main>
</div>
{#if modal !== 'none'}
<div class="modal-backdrop" role="presentation">
  <div class="modal" class:settings-dialog={modal === 'settings'} role="dialog" aria-modal="true" aria-label="Settings or confirmation">
    {#if modal === 'settings'}
      <h2>Connection settings</h2><p>Each user must enter their own Secure MCP Tunnel details. The API key is stored in Windows Credential Manager, not in the EXE.</p>
      <div class="field"><label for="tunnel-id">Tunnel ID</label><input id="tunnel-id" autocomplete="off" bind:value={newTunnelID} placeholder="tunnel_..."/></div>
      <div class="field"><label for="org-id">Organization ID (if required)</label><input id="org-id" autocomplete="off" bind:value={newOrganizationID} placeholder="org-..."/><div class="hint">Required when your tunnel uses organization-scoped access.</div></div>
      <div class="field"><label for="api-key">Control Plane API key</label><input id="api-key" type="password" autocomplete="new-password" bind:value={newKey} placeholder={status.has_key ? 'Saved — leave empty to keep' : 'Enter your API key'}/><div class="hint">Leave blank to preserve the existing key. Key values are never shown.</div></div>
      <div class="modal-actions"><button class="btn" onclick={() => modal = 'none'}>Cancel</button><button class="btn" disabled={working} onclick={() => execute(async () => {await invoke('save_connection',{tunnelId:newTunnelID, organizationId:newOrganizationID, apiKey:newKey});modal='none';newKey='';},'연결 정보가 저장되었습니다.')}>Save</button></div>
    {:else if modal === 'restart'}
      <h2>Restart Desktop Commander?</h2><p>Active commands and open file operations may be interrupted. The tunnel connection itself will remain running.</p>
      <div class="modal-actions"><button class="btn" onclick={() => modal = 'none'}>Cancel</button><button class="btn" onclick={() => execute(async()=>{await invoke('restart_dc');modal='none';},'Desktop Commander 재시작을 요청했습니다.')}>Restart</button></div>
    {:else}
      <h2>Quit Commander Manager?</h2><p>The managed tunnel will be disconnected. Closing the window with X only hides it to the system tray.</p>
      <div class="modal-actions"><button class="btn" onclick={() => modal = 'none'}>Cancel</button><button class="btn" onclick={() => invoke('exit_manager')}>Exit app</button></div>
    {/if}
  </div>
</div>
{/if}
