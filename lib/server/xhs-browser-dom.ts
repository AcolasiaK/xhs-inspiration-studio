// Selectors shared by the OpenClaw search and the hotspot collector.
export const guardCode = `() => {
 const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
 const text=document.body.innerText.slice(0,5000);
 return { blocked:/captcha|website-login/.test(location.pathname)||/安全验证|请完成验证|访问频次异常/.test(text), login:Array.from(document.querySelectorAll('.login-container,.login-modal')).some(visible), host:location.hostname };
}`;
export const cardsCode = String.raw`() => {
 const me=Array.from(document.querySelectorAll('a[href*="/user/profile/"]')).find(a=>a.innerText.trim()==='我')?.getAttribute('href')?.match(/profile\/([a-f0-9]+)/)?.[1];
 return Array.from(document.querySelectorAll('section.note-item')).flatMap(s=>{
  const id=s.querySelector('a[href*="/explore/"]')?.getAttribute('href')?.match(/[a-f0-9]{24}/)?.[0];
  const author=s.querySelector('.author')?.getAttribute('href')?.match(/profile\/([a-f0-9]+)/)?.[1];
  return id?[{id,top:s.getBoundingClientRect().top+window.scrollY,authorId:author||null,title:s.querySelector('.title')?.innerText||'',date:s.querySelector('.time')?.innerText||'',likes:s.querySelector('.like-wrapper .count')?.innerText||'',own:!!me&&author===me}]:[];
 });
}`;
export const detailCode = `() => {
 const n=document.querySelector('#noteContainer'); if(!n)return null;
 const t=s=>n.querySelector(s)?.innerText?.trim()||'';
 return {authorId:n.querySelector('.author-container a[href*="/user/profile/"]')?.getAttribute('href')?.match(/profile\\/([a-f0-9]{24})/)?.[1]||null,id:location.pathname.match(/[a-f0-9]{24}/)?.[0],title:t('.title'),body:t('#detail-desc')||t('.desc'),author:t('.author-container .username')||t('.author .username')||t('.author-container .name'),date:t('.note-content .date'),tags:Array.from(n.querySelectorAll('.desc a.tag,.desc a[href*="search_result"]')).map(e=>e.innerText.replace(/^#/,'')).slice(0,40),likes:n.querySelector('.interact-container .like-wrapper .count')?.innerText??null,collects:n.querySelector('.interact-container .collect-wrapper .count')?.innerText??null,comments:n.querySelector('.interact-container .chat-wrapper .count')?.innerText??null,cover:!!n.querySelector('.swiper-slide-active img')};
}`;
export const openFiltersCode = `() => {const e=document.querySelector('.filter');if(!e)return false;e.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));e.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));return true;}`;
export function selectXhsFilterCode(group: string, label: string) {
  return `() => {const row=Array.from(document.querySelectorAll('.filter-panel .filters')).find(e=>e.firstElementChild?.textContent.trim()===${JSON.stringify(group)});const tags=Array.from(row?.querySelectorAll('.tags')||[]).filter(e=>e.getAttribute('aria-hidden')!=='true'&&Number(getComputedStyle(e).opacity)>.5&&e.getBoundingClientRect().width>0);const e=tags.find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e)return 'missing';if(e.classList.contains('active'))return 'selected';e.click();return 'clicked';}`;
}
export const filterStateCode = `() => Object.fromEntries(Array.from(document.querySelectorAll('.filter-panel .filters')).map(row=>[row.firstElementChild?.textContent.trim(),Array.from(row.querySelectorAll('.tags.active')).filter(e=>e.getAttribute('aria-hidden')!=='true'&&Number(getComputedStyle(e).opacity)>.5).map(e=>e.textContent.trim()).join(',')]))`;

// Keep UI steps in the owned tab so that each filter does not need another CLI connection.
export function applySearchFiltersCode(wanted: Record<string, string>) {
  const choices = Object.entries(wanted).map(([group, label]) => selectXhsFilterCode(group, label)).join(',');
  return `async () => {
    const guard=(${guardCode}), pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const stopped=state=>state.host!=='www.xiaohongshu.com'||state.blocked||state.login;
    for(let i=0;i<12;i++) {
      const state=guard(); if(stopped(state))return {state};
      if(document.querySelector('.filter'))break;
      await pause(250);
    }
    for (let attempt=0;attempt<2;attempt++) {
      let state=guard(); if(stopped(state))return {state};
      (${openFiltersCode})(); await pause(250);
      for(const select of [${choices}]) {
        state=guard(); if(stopped(state))return {state};
        if(select()==='clicked')await pause(850);
      }
      state=guard(); if(stopped(state))return {state};
      const selected=(${filterStateCode})();
      if(Object.entries(${JSON.stringify(wanted)}).every(([key,label])=>selected[key]===label)) {
        document.querySelector('.filter')?.dispatchEvent(new MouseEvent('mouseleave',{bubbles:true}));
        await pause(1100); return {state:guard(),applied:true};
      }
      await pause(400);
    }
    return {state:guard(),applied:false};
  }`;
}

export function readSearchCardCode(id: string) {
  return `async () => {
    const guard=(${guardCode}), stopped=state=>state.host!=='www.xiaohongshu.com'||state.blocked||state.login;
    let state=guard(); if(stopped(state))return {state};
    const id=${JSON.stringify(id)};
    const note=Array.from(document.querySelectorAll('section.note-item')).find(item=>
      item.querySelector('a[href*="/explore/'+id+'"]'));
    const cover=note?.querySelector('a.cover[href*="/search_result/"]');
    if(!cover)return {state,clicked:false};
    cover.scrollIntoView({block:'center'}); cover.click();
    const deadline=Date.now()+8000;
    do {
      await new Promise(resolve=>setTimeout(resolve,250));
      state=guard(); if(stopped(state))return {state,clicked:true};
      const detail=(${detailCode})();
      if(detail?.id===id && detail.date && (detail.authorId||detail.author) &&
         [detail.likes,detail.collects,detail.comments].every(count=>count?.trim()))return {state,clicked:true,detail};
    } while(Date.now()<deadline);
    return {state,clicked:true,detail:null};
  }`;
}
