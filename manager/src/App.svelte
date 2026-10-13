<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { open } from '@tauri-apps/plugin-dialog';

  type Status = { running: boolean; ready: boolean; restricted: boolean; allowed_folders: string[]; tunnel_id: string; has_key: boolean; runtime_ready: boolean; runtime_message: string };
  let status = $state<Status>({ running: false, ready: false, restricted: true, allowed_folders: [], tunnel_id: '', has_key: false, runtime_ready: false, runtime_message: '' });
  let selected = $state<string | null>(null);
  let modal = $state<'none' | 'settings' | 'unrestricted' | 'exit' | 'restart'>('none');
  let working = $state(false);
  let error = $state('');
  let notice = $state('');
  let newTunnelID = $state('');
  let newKey = $state('');

  const icons: Record<string,string> = {
    folder: 'M3 7h7l2 2h9v11H3z',
    plus: 'M12 5v14M5 12h14',
    trash: 'M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5',
    restart: 'M20 7v5h-5M4 17v-5h5M5.5 9A7.5 7.5 0 0 1 18.5 7M18.5 15A7.5 7.5 0 0 1 5.5 17',
    power: 'M12 2v10M6.3 5.5a9 9 0 1 0 11.4 0',
    unplug: 'M8 3v5M16 3v5M6 8h12v4a6 6 0 0 1-6 6v3',
    settings: 'M4 7h16M4 17h16M9 5v4M16 15v4'
  };
  async function refresh() { status = await invoke<Status>('get_status'); if (selected && !status.allowed_folders.includes(selected)) selected = null; }
  onMount(() => { refresh().catch(e => error = String(e)); const clock = setInterval(() => refresh().catch(() => {}), 2500); return () => clearInterval(clock); });
  async function execute(action: () => Promise<unknown>, success = '') {
    error = ''; notice = ''; working = true;
    try { await action(); await refresh(); notice = success; } catch (e) { error = String(e); } finally { working = false; }
  }
  function toggleRestricted() {
    if (status.restricted) modal = 'unrestricted';
    else void execute(() => invoke('set_restricted', { restricted: true }), '접근 제한이 적용되었습니다. 실행 중인 DC 작업은 중단될 수 있습니다.');
  }
  async function addFolder() {
    try { const selectedPath = await open({ directory: true, multiple: false, title: '허용할 폴더 선택' });
      if (typeof selectedPath === 'string') await execute(() => invoke('add_folder', { path: selectedPath }), '폴더가 허용 목록에 추가되었습니다.');
    } catch (e) { error = String(e); }
  }
  function openSettings() { newTunnelID = status.tunnel_id; newKey = ''; modal = 'settings'; }
</script>

<svelte:head><title>Desktop Commander Manager</title></svelte:head>
<div class="shell">
  <header class="top">
    <div class="logo">›_</div>
    <div class="grow"><div class="name">Desktop Commander</div><div class="sub">Remote manager</div></div>
    <div class:up={status.ready} class="status"><span class="dot"></span>{status.ready ? 'Ready' : status.running ? 'Starting' : 'Stopped'}</div>
  </header>
  <main class="content">
    <div class="actions">
      <button class="btn" disabled={working} onclick={() => execute(() => invoke(status.running ? 'disconnect_tunnel' : 'connect_tunnel'), status.running ? '터널 연결을 해제했습니다.' : '터널 실행 명령을 보냈습니다.')}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d={icons.unplug}/></svg>
        {status.running ? 'Disconnect' : 'Connect'}
      </button>
      <button class="btn" disabled={working || !status.running} onclick={() => modal = 'restart'}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d={icons.restart}/></svg>Restart DC
      </button>
    </div>
    <div class="divider"></div>
    <div class="restriction">
      <div class="grow"><div class="section-title">Directory restriction</div><div class="section-sub">{status.restricted ? 'Only selected folders are accessible' : 'Full user-level access enabled'}</div></div>
      <button aria-label="Directory restriction" role="switch" aria-checked={status.restricted} class:on={status.restricted} class="toggle" disabled={working} onclick={toggleRestricted}><span class="knob"></span></button>
    </div>
    <div class="folder-panel">
      <div class="panel-head"><strong>Allowed folders</strong><span class="count">{status.allowed_folders.length} folders</span></div>
      <div class="folder-scroll" role="listbox" aria-label="Allowed folders">
        {#if status.allowed_folders.length === 0}<div class="empty">Add a folder to enable restricted access.</div>{/if}
        {#each status.allowed_folders as path (path)}
          <button class="folder-row" class:selected={selected === path} role="option" aria-selected={selected === path} title={path} onclick={() => selected = selected === path ? null : path}>
            <svg class="folder-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65"><path d={icons.folder}/></svg>
            <span class="path">{path}</span><span class="check">{selected === path ? '✓' : ''}</span>
          </button>
        {/each}
      </div>
      <div class="folder-actions">
        <button class="text-btn" disabled={working} onclick={addFolder}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d={icons.plus}/></svg>Add folder</button>
        <button class="text-btn muted" disabled={working || !selected} onclick={() => selected && execute(() => invoke('remove_folder', { path: selected }), '선택한 폴더를 제거했습니다.')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d={icons.trash}/></svg>Remove selected
        </button>
      </div>
    </div>
    <div class="footnote"><span class="point">●</span>New requests use the updated policy immediately.</div>
    {#if !status.runtime_ready}<div class="disabled-note" title={status.runtime_message}>Runtime not bundled — see README for packaging.</div>{/if}
    <div class="spacer"></div>
    <div class="bottom">
      <button onclick={openSettings}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d={icons.settings}/></svg>Connection settings</button>
      <button onclick={() => modal = 'exit'}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d={icons.power}/></svg>Exit</button>
    </div>
    {#if error}<div class="error" role="alert">{error}</div>{/if}
    {#if notice}<div class="notice" role="status">{notice}</div>{/if}
  </main>
</div>
{#if modal !== 'none'}
<div class="modal-backdrop" role="presentation">
  <div class="modal" role="dialog" aria-modal="true" aria-label="Settings or confirmation">
    {#if modal === 'settings'}
      <h2>Connection settings</h2><p>Each user must enter their own Secure MCP Tunnel details. The API key is stored in Windows Credential Manager, not in the EXE.</p>
      <div class="field"><label for="tunnel-id">Tunnel ID</label><input id="tunnel-id" autocomplete="off" bind:value={newTunnelID} placeholder="tunnel_..."/></div>
      <div class="field"><label for="api-key">Control Plane API key</label><input id="api-key" type="password" autocomplete="new-password" bind:value={newKey} placeholder={status.has_key ? 'Saved — leave empty to keep' : 'Enter your API key'}/><div class="hint">Leave blank to preserve the existing key. Key values are never shown.</div></div>
      <div class="modal-actions"><button class="btn" onclick={() => modal = 'none'}>Cancel</button><button class="btn" disabled={working} onclick={() => execute(async () => {await invoke('save_connection',{tunnelId:newTunnelID, apiKey:newKey});modal='none';newKey='';},'연결 정보가 저장되었습니다.')}>Save</button></div>
    {:else if modal === 'unrestricted'}
      <h2>Disable directory restriction?</h2><p class="warn">Desktop Commander will be able to access files and run commands with your Windows user permissions.</p>
      <div class="modal-actions"><button class="btn" onclick={() => modal = 'none'}>Cancel</button><button class="btn" onclick={() => execute(async()=>{await invoke('set_restricted',{restricted:false});modal='none';},'전체 접근 모드입니다.')}>Allow full access</button></div>
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
