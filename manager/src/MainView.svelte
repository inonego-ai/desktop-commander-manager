<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';

  type Status = { running: boolean; ready: boolean; tunnel_id: string; organization_id: string; has_key: boolean; runtime_ready: boolean; runtime_message: string; connection_issue: string | null };
  type Level = 'info' | 'success' | 'warning' | 'error';
  type Entry = { id: number; time: string; level: Level; message: string };
  let status = $state<Status>({ running: false, ready: false, tunnel_id: '', organization_id: '', has_key: false, runtime_ready: false, runtime_message: '', connection_issue: null });
  let modal = $state<'none'|'settings'|'restart'|'exit'>('none');
  let working = $state(false);
  let entries = $state<Entry[]>([]);
  let logScroll: HTMLDivElement;
  let nextID = 0;
  let oldStatus = '';
  let oldIssue = '';
  let oldRuntimeReady: boolean | null = null;
  let oldRefreshError = '';
  let newTunnelID = $state('');
  let newOrganizationID = $state('');
  let newKey = $state('');

  const icons: Record<string,string> = {
    restart: 'M20 7v5h-5M4 17v-5h5M5.5 9A7.5 7.5 0 0 1 18.5 7M18.5 15A7.5 7.5 0 0 1 5.5 17',
    unplug: 'M8 3v5M16 3v5M6 8h12v4a6 6 0 0 1-6 6v3',
    settings: 'M4 7h16M4 17h16M9 5v4M16 15v4',
    power: 'M12 2v10M6.3 5.5a9 9 0 1 0 11.4 0'
  };
  function log(level: Level, message: string) {
    const nearBottom = !logScroll || logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < 32;
    entries = [...entries.slice(-149), {
      id: ++nextID, time: new Date().toLocaleTimeString('ko-KR', {hour12:false}), level, message
    }];
    if (nearBottom) void tick().then(() => {
      if (logScroll) logScroll.scrollTop = logScroll.scrollHeight;
    });
  }
  async function refresh() {
    const next = await invoke<Status>('get_status');
    const current = next.connection_issue ? 'error' : next.ready ? 'ready' : next.running ? 'starting' : 'stopped';
    if (current !== oldStatus) {
      if (current === 'ready') log('success','터널 연결이 준비되었습니다.');
      else if (current === 'starting') log('info','터널 연결 상태를 확인하고 있습니다.');
      else if (current === 'stopped') log('warning','터널 연결이 해제되었습니다.');
      oldStatus = current;
    }
    if (next.connection_issue && oldIssue !== next.connection_issue) log('error',next.connection_issue);
    oldIssue = next.connection_issue || '';
    if (!next.runtime_ready && oldRuntimeReady !== false) log('error',next.runtime_message || '실행 리소스를 찾을 수 없습니다.');
    oldRuntimeReady = next.runtime_ready;
    oldRefreshError = '';
    status = next;
  }
  async function refreshSafely() {
    try { await refresh(); } catch (error) {
      if (oldRefreshError !== String(error)) log('error','상태 확인 실패: '+error);
      oldRefreshError = String(error);
    }
  }
  onMount(() => {
    log('info','연결 관리자가 시작되었습니다.');
    void refreshSafely();
    const clock = setInterval(() => void refreshSafely(), 2500);
    return () => clearInterval(clock);
  });
  async function execute(action: () => Promise<unknown>, success = '', level: Level = 'info') {
    working = true;
    try {
      await action();
      if (success) log(level,success);
      await refreshSafely();
    } catch (e) { log('error',String(e)); }
    finally { working = false; }
  }
  function settings() {
    newTunnelID = status.tunnel_id;
    newOrganizationID = status.organization_id;
    newKey = '';
    modal = 'settings';
  }
</script>

<svelte:head><title>Desktop Commander | 연결 관리자</title></svelte:head>
<div class="shell">
  <header class="top">
    <div class="logo">›_</div>
    <div class="grow">
      <div class="name">Desktop Commander</div>
      <div class="sub">원격 연결 관리자</div>
    </div>
    <div class="status" class:up={status.ready} class:failed={Boolean(status.connection_issue)}>
      <span class="dot"></span>
      {status.connection_issue ? '오류' : status.ready ? '연결됨' : status.running ? '연결 중' : '연결 끊김'}
    </div>
  </header>
  <main class="dashboard">
    <section class="hub-panel" aria-label="연결 제어와 확장 기능">
      <div class="section-bar"><strong>연결 제어</strong></div>
      <div class="actions">
        <button class="btn" disabled={working} onclick={() => execute(
          () => invoke(status.running ? 'disconnect_tunnel' : 'connect_tunnel'),
          status.running ? '터널 연결이 해제되었습니다.' : '터널 연결을 시작했습니다.',
          status.running ? 'warning' : 'info'
        )}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d={icons.unplug}/></svg>
          {status.running ? '연결 해제' : '연결'}
        </button>
        <button class="btn" disabled={working || !status.running} onclick={() => modal = 'restart'}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d={icons.restart}/></svg>
          커맨더 재시작
        </button>
      </div>
      <div class="divider"></div>
      <div class="section-bar"><strong>확장 기능</strong><span class="muted">0개</span></div>
      <div class="extension-grid" aria-label="등록된 확장 기능">
        <p class="extension-empty">등록된 확장 기능이 없습니다.</p>
      </div>
      <p class="hub-hint">확장 기능이 등록되면 이 영역에서 사용할 수 있습니다.</p>
      <div class="bottom">
        <button onclick={settings}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d={icons.settings}/></svg>연결 설정
        </button>
        <button onclick={() => modal = 'exit'}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d={icons.power}/></svg>종료
        </button>
      </div>
    </section>
    <section class="activity-panel" aria-label="활동 기록">
      <div class="activity-head">
        <strong>활동 기록</strong><span class="activity-count">{entries.length} / 150</span>
      </div>
      <div class="activity-scroll" bind:this={logScroll} role="log" aria-live="polite" aria-relevant="additions" aria-label="연결 및 앱 이벤트">
        {#each entries as entry (entry.id)}
          <div class="log-entry" class:info={entry.level === 'info'} class:success={entry.level === 'success'} class:warning={entry.level === 'warning'} class:error={entry.level === 'error'}>
            <div class="log-meta">
              <span class="log-level">{entry.level === 'success' ? '정상' : entry.level === 'warning' ? '주의' : entry.level === 'error' ? '오류' : '정보'}</span>
              <time class="log-time">{entry.time}</time>
            </div>
            <div class="log-message">{entry.message}</div>
          </div>
        {/each}
      </div>
    </section>
  </main>
</div>
{#if modal !== 'none'}
  <div class="modal-backdrop" role="presentation">
    <div class="modal" class:settings-dialog={modal === 'settings'} role="dialog" aria-modal="true" aria-label="설정 또는 확인">
      {#if modal === 'settings'}
        <h2>연결 설정</h2>
        <p>본인의 보안 MCP 터널 정보를 입력하세요. API 키는 실행 파일이 아닌 Windows 자격 증명 관리자에 보관됩니다.</p>
        <div class="field"><label for="tunnel-id">터널 ID</label><input id="tunnel-id" autocomplete="off" bind:value={newTunnelID} placeholder="tunnel_..."/></div>
        <div class="field"><label for="org-id">조직 ID (선택)</label><input id="org-id" autocomplete="off" bind:value={newOrganizationID} placeholder="org-..."/><div class="hint">조직 단위 접근이 필요한 터널에서만 입력합니다.</div></div>
        <div class="field"><label for="api-key">연결용 API 키</label><input id="api-key" type="password" autocomplete="new-password" bind:value={newKey} placeholder={status.has_key ? '저장됨 — 빈칸으로 두면 유지' : 'API 키 입력'}/><div class="hint">기존 키를 유지하려면 비워 두세요. 저장된 키 값은 표시하지 않습니다.</div></div>
        <div class="modal-actions"><button class="btn" onclick={() => modal = 'none'}>취소</button><button class="btn" disabled={working} onclick={() => execute(async () => { await invoke('save_connection',{tunnelId:newTunnelID, organizationId:newOrganizationID, apiKey:newKey}); modal='none'; newKey='';}, '연결 설정을 저장했습니다.')}>저장</button></div>
      {:else if modal === 'restart'}
        <h2>커맨더를 재시작할까요?</h2><p>현재 실행 중인 명령이나 파일 작업이 중단될 수 있습니다. 터널 연결은 유지됩니다.</p>
        <div class="modal-actions"><button class="btn" onclick={() => modal = 'none'}>취소</button><button class="btn" onclick={() => execute(async () => { await invoke('restart_dc'); modal = 'none'; }, '커맨더 재시작을 요청했습니다.')}>재시작</button></div>
      {:else}
        <h2>연결 관리자를 종료할까요?</h2><p>터널 연결이 해제됩니다. 창의 X 버튼으로 닫으면 앱은 트레이에 남습니다.</p>
        <div class="modal-actions"><button class="btn" onclick={() => modal = 'none'}>취소</button><button class="btn" onclick={() => invoke('exit_manager')}>종료</button></div>
      {/if}
    </div>
  </div>
{/if}
