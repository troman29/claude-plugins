import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hubPath = join(import.meta.dir, '../src/hub.ts')

test.each(['new', 'existing'] as const)('new Telegram topic selects DSH and %s conversation without bind commands', async selection => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-auto-topic-'))
  const project = join(root, 'project')
  mkdirSync(project)
  writeFileSync(join(root, 'trusted-groups.json'), JSON.stringify({ groups: {
    '-100': { dir: project, modes: ['folder'], agents: ['claude', 'codex'] },
  } }))
  const script = `
    const { bot, handleStubMessage } = await import(${JSON.stringify(hubPath)});
    const { loadBindings } = await import(${JSON.stringify(join(import.meta.dir, '../src/registry.ts'))});
    const posts = [];
    bot.botInfo = { id: 99, is_bot: true, first_name: 'Test', username: 'test_bot' };
    bot.api.config.use(async (_next, method, payload) => {
      posts.push({ method, ...payload });
      return { ok: true, result: method === 'sendMessage' ? { message_id: posts.length, date: 1, chat: { id: -100, type: 'supergroup' }, ...payload } : true };
    });
    const runtime = { write(frame) {
      const msg = JSON.parse(frame);
      if (msg.op === 'dsh-runtime-command') queueMicrotask(() => handleStubMessage(runtime, {
        op:'dsh-runtime-result', id:msg.id, ok:true,
        result:JSON.stringify(msg.command.action==='create' ? {sessionId:msg.command.sessionId} : [{sessionId:'existing-session',cwd:${JSON.stringify(project)},title:'Existing conversation'}]),
      }));
    }, end() {} };
    await handleStubMessage(runtime, {op:'dsh-runtime',runtime:{runtime:'web',profile:'web',label:'DSH Web'}});
    let seq=1;
    const chat={id:-100,type:'supergroup',title:'Test'};
    const from={id:1,is_bot:false,first_name:'Admin'};
    const message={message_id:42,date:1,chat,message_thread_id:42};
    await bot.handleUpdate({update_id:seq++,message:{...message,from,forum_topic_created:{name:'Work',icon_color:1}}});
    const tick=()=>new Promise(resolve=>setImmediate(resolve));
    await tick();
    const tap=async data=>{ await bot.handleUpdate({update_id:seq++,callback_query:{id:String(seq),from,chat_instance:'test',data,message}}); await tick(); };
    await tap('topicharness:-100/42');
    await tap('topicharness:-100/42');
    if (!posts.some(post=>JSON.stringify(post.reply_markup ?? {}).includes('DSH'))) throw Error('DSH absent from harness picker');
    await tap('topicmode:-100/42:folder');
    for(let i=0;i<30 && !posts.some(post=>JSON.stringify(post.reply_markup ?? {}).includes('dshpick:'));i++) await tick();
    const picker=posts.findLast(post=>JSON.stringify(post.reply_markup ?? {}).includes('dshpick:'));
    if(!picker) throw Error('DSH session picker missing');
    await tap(picker.reply_markup.inline_keyboard[${selection === 'new' ? 0 : 1}][0].callback_data);
    const selected=loadBindings()['-100/42']?.dsh?.sessionId;
    if(${selection === 'existing' ? "selected!=='existing-session'" : "!selected || selected==='existing-session'"}) throw Error('Wrong conversation');
    if(loadBindings()['-100/42']?.tmux) throw Error('DSH incorrectly launched through tmux');
    const prompts=[];
    const session={write(frame){const msg=JSON.parse(frame); if(msg.op==='dsh-command'){
      prompts.push(msg.command);
      queueMicrotask(()=>handleStubMessage(session,{op:'dsh-result',id:msg.id,ok:true,result:'accepted'}));
    }},end(){}};
    await handleStubMessage(session,{op:'dsh-subscribe',claim:{key:'-100/42',...loadBindings()['-100/42'].dsh}});
    await bot.handleUpdate({update_id:seq++,message:{...message,message_id:43,from,text:'first task'}});
    for(let i=0;i<30 && !prompts.length;i++) await tick();
    if(prompts.length!==1 || prompts[0].text!=='first task') throw Error('First task did not reach DSH exactly once');
  `
  try {
    const child = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env,
      TELEGRAM_STATE_DIR: root, TELEGRAM_BOT_TOKEN: '123:TEST', TELEGRAM_ADMINS: '1', TELEGRAM_DEBUG_LOG: '0',
    }, stdout: 'pipe', stderr: 'pipe' })
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    if (exit !== 0) {
      throw new Error(stderr)
    }
    expect(exit).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
