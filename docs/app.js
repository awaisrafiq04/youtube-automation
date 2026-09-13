import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";

const config=window.APP_CONFIG||{},configured=Boolean(config.supabaseUrl&&config.supabasePublishableKey);
const supabase=configured?createClient(config.supabaseUrl,config.supabasePublishableKey):null;
const state={session:null,videos:[],channels:[],history:[],view:"overview"};
const $=(s)=>document.querySelector(s),$$=(s)=>[...document.querySelectorAll(s)];
const esc=(v="")=>String(v).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c]);
const when=(v)=>v?new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(v)):"Never";

function toast(message,error=false){const el=$("#toast");el.textContent=message;el.className=`toast show${error?" error":""}`;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.className="toast",3500)}
function busy(button,on,label="Working…"){if(!button.dataset.label)button.dataset.label=button.textContent;button.disabled=on;button.textContent=on?label:button.dataset.label}

async function loadData(){
  const [videos,channels,history]=await Promise.all([
    supabase.from("videos").select("id,storage_path,title,description,tags,category_id,privacy_status,posted,posted_at,youtube_video_id,created_at").order("posted_at",{ascending:true,nullsFirst:true}),
    supabase.from("youtube_channels").select("id,youtube_channel_id,display_name,thumbnail_url,active,connected_at,last_used_at").order("connected_at"),
    supabase.from("upload_history").select("id,video_id,channel_id,status,youtube_video_id,error_message,created_at,videos(title),youtube_channels(display_name)").order("created_at",{ascending:false}).limit(100)
  ]);
  for(const result of [videos,channels,history])if(result.error)throw result.error;
  state.videos=videos.data||[];state.channels=channels.data||[];state.history=history.data||[];render();
}

function render(){
  const channel=state.channels.find(c=>c.active),last=state.history[0];
  $("#stat-videos").textContent=state.videos.length;$("#stat-channel").textContent=channel?.display_name||"None";$("#stat-channel-note").textContent=channel?"ready for uploads":"connect a channel";$("#stat-last").textContent=last?when(last.created_at).split(",")[0]:"None";$("#stat-last-note").textContent=last?last.status:"no activity";$("#video-count").textContent=`${state.videos.length} video${state.videos.length===1?"":"s"} in the workspace`;
  $("#next-videos").innerHTML=state.videos.slice(0,3).map(v=>`<div class="compact-row"><strong>${esc(v.title)}</strong><span>${when(v.posted_at)}</span></div>`).join("")||"<p>No queued videos.</p>";
  $("#video-list").innerHTML=state.videos.map(v=>`<article class="video-row"><div class="video-title"><strong>${esc(v.title)}</strong><span>${esc(v.storage_path)}</span></div><span class="badge ${esc(v.privacy_status)}">${esc(v.privacy_status)}</span><span class="meta">${v.posted_at?`Last: ${esc(when(v.posted_at))}`:"Not uploaded"}</span><button class="button secondary" data-edit-video="${v.id}">Edit / replace</button></article>`).join("");
  $("#video-empty").hidden=state.videos.length>0;
  $("#channel-list").innerHTML=state.channels.map(c=>`<article class="channel-card ${c.active?"active-channel":""}"><div class="channel-head">${c.thumbnail_url?`<img src="${esc(c.thumbnail_url)}" alt="">`:'<span class="channel-avatar"></span>'}<div><h3>${esc(c.display_name)}</h3><span class="meta">${esc(c.youtube_channel_id)}</span></div></div><p>${c.active?"Active publishing destination":`Connected ${esc(when(c.connected_at))}`}</p><div class="channel-actions">${c.active?'<span class="badge">Active</span>':`<button class="button secondary" data-activate-channel="${c.id}">Make active</button>`}<button class="button danger" data-delete-channel="${c.id}" data-channel-name="${esc(c.display_name)}">Delete</button></div></article>`).join("");
  $("#channel-empty").hidden=state.channels.length>0;
  $("#history-list").innerHTML=state.history.map(h=>`<tr><td>${esc(h.videos?.title||"Unknown video")}</td><td>${esc(h.youtube_channels?.display_name||"Default channel")}</td><td><span class="badge ${h.status==="failed"?"failed":""}">${esc(h.status)}</span></td><td>${esc(h.youtube_video_id||"—")}</td><td>${esc(when(h.created_at))}</td></tr>`).join("");
  $("#history-empty").hidden=state.history.length>0;$(".table-wrap").hidden=state.history.length===0;
}

function showView(view){const titles={overview:"Overview",videos:"Videos",channels:"Channels",history:"Upload history"};if(!titles[view])view="overview";state.view=view;$$('.view').forEach(el=>{el.hidden=el.id!==`view-${view}`;el.classList.toggle("active-view",!el.hidden)});$$('.nav-item').forEach(b=>b.classList.toggle("active",b.dataset.view===view));$("#view-title").textContent=titles[view];location.hash=view}
function openDialog(video=null){$("#video-form").reset();$("#video-id").value=video?.id||"";$("#video-title").value=video?.title||"";$("#video-description").value=video?.description||"";$("#video-tags").value=(video?.tags||["Shorts"]).join(", ");$("#video-category").value=video?.category_id||"22";$("#video-privacy").value=video?.privacy_status||"private";$("#video-ready").checked=video?!video.posted:false;$("#video-file").required=!video;$("#dialog-title").textContent=video?"Edit or replace video":"Upload video";$("#video-error").textContent="";$("#upload-progress").hidden=true;$("#video-dialog").showModal()}

async function saveVideo(event){
  event.preventDefault();const button=$("#video-save"),id=$("#video-id").value,file=$("#video-file").files[0];busy(button,true,file?"Uploading…":"Saving…");$("#video-error").textContent="";
  try{
    let path=state.videos.find(v=>v.id===id)?.storage_path;
    if(file){if(file.type&&file.type!=="video/mp4")throw new Error("Choose an MP4 video file.");const safe=file.name.replace(/[^a-zA-Z0-9._-]/g,"-");path=`${state.session.user.id}/${crypto.randomUUID()}-${safe}`;$("#upload-progress").hidden=false;const up=await supabase.storage.from(config.bucket||"shorts-videos").upload(path,file,{contentType:"video/mp4",upsert:false});if(up.error)throw up.error;$("#upload-progress").value=100}
    const raw=$("#video-title").value.trim(),title=raw.toLowerCase().includes("#shorts")?raw:`${raw.slice(0,92).trim()} #Shorts`,tags=$("#video-tags").value.split(",").map(t=>t.trim()).filter(Boolean);if(!tags.some(t=>t.replace(/^#/,"").toLowerCase()==="shorts"))tags.push("Shorts");
    const payload={user_id:state.session.user.id,storage_path:path,title,description:$("#video-description").value,tags,category_id:$("#video-category").value,privacy_status:$("#video-privacy").value,posted:!$("#video-ready").checked};
    const result=id?await supabase.from("videos").update(payload).eq("id",id):await supabase.from("videos").insert(payload);if(result.error)throw result.error;$("#video-dialog").close();toast(id?"Video updated":"Video added to the queue");await loadData();
  }catch(error){$("#video-error").textContent=error.message||String(error)}finally{busy(button,false)}
}

async function connectChannel(){const button=$("#connect-channel");busy(button,true,"Opening Google…");try{const{data,error}=await supabase.functions.invoke("google-oauth-start");if(error)throw error;if(!data?.url)throw new Error("OAuth function returned no authorization URL.");location.href=data.url}catch(error){toast(error.message||String(error),true);busy(button,false)}}
async function activateChannel(id){const{error}=await supabase.rpc("set_active_youtube_channel",{p_channel_id:id});if(error)return toast(error.message,true);toast("Active channel changed");await loadData()}
async function deleteChannel(button){
  const id=button.dataset.deleteChannel,name=button.dataset.channelName||"this channel";
  if(!confirm(`Delete ${name}? Its saved Google authorization will be removed and scheduled uploads will no longer use it.`))return;
  busy(button,true,"Deleting…");
  const{error}=await supabase.rpc("delete_youtube_channel",{p_channel_id:id});
  if(error){toast(error.message||String(error),true);busy(button,false);return}
  toast("Channel deleted");await loadData();
}

function bind(){
  $("#login-form").addEventListener("submit",async event=>{event.preventDefault();const button=event.submitter;busy(button,true,"Signing in…");$("#login-error").textContent="";const{error}=await supabase.auth.signInWithPassword({email:$("#login-email").value,password:$("#login-password").value});if(error)$("#login-error").textContent=error.message;busy(button,false)});
  $("#logout-button").addEventListener("click",()=>supabase.auth.signOut());$$('.nav-item').forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));$$('[data-go]').forEach(b=>b.addEventListener("click",()=>showView(b.dataset.go)));[$("#upload-open"),$("#upload-open-secondary")].forEach(b=>b.addEventListener("click",()=>openDialog()));$$('[data-close]').forEach(b=>b.addEventListener("click",()=>$("#video-dialog").close()));$("#video-form").addEventListener("submit",saveVideo);$("#connect-channel").addEventListener("click",connectChannel);
  document.addEventListener("click",event=>{const edit=event.target.closest("[data-edit-video]");if(edit)openDialog(state.videos.find(v=>v.id===edit.dataset.editVideo));const active=event.target.closest("[data-activate-channel]");if(active)activateChannel(active.dataset.activateChannel);const remove=event.target.closest("[data-delete-channel]");if(remove)deleteChannel(remove)});
}
async function handleSession(session){state.session=session;$("#login-view").hidden=Boolean(session);$("#dashboard").hidden=!session;if(!session)return;$("#user-email").textContent=session.user.email;showView(location.hash.slice(1)||"overview");try{await loadData()}catch(error){toast(error.message||String(error),true)}}
async function init(){if(!configured){$("#login-error").textContent="Dashboard configuration is missing. Add the GitHub Pages repository variables first.";$("#login-form button").disabled=true;return}bind();const{data}=await supabase.auth.getSession();await handleSession(data.session);supabase.auth.onAuthStateChange((_event,session)=>setTimeout(()=>handleSession(session),0));const params=new URLSearchParams(location.search);if(params.get("channel")==="connected"){history.replaceState({},"",location.pathname+"#channels");toast("YouTube channel connected");showView("channels")}if(params.get("oauth_error"))toast(params.get("oauth_error"),true)}
init();
