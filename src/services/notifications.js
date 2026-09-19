 'use strict';
const day=date=>date.toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'});
function buildNotifications({trainings=[],payments=[]},now=new Date()){
 const today=day(now),upcoming=day(new Date(+now+7*86400000));
 const items=trainings.filter(x=>x.id&&(x.updatedAt||x.createdAt)).map(x=>({id:'training:'+x.id+':'+(x.updatedAt||x.createdAt),kind:'training',title:x.updatedAt&&x.updatedAt!==x.createdAt?'Treinamento atualizado':'Treinamento disponível',message:String(x.title||'Treinamento').slice(0,160)+(x.track?' · '+String(x.track).slice(0,80):''),date:x.updatedAt||x.createdAt,route:'treinamentos'}));
 for(const p of payments){if(!['pending','overdue'].includes(p.status)||!p.due_date||p.due_date>upcoming)continue;const late=p.due_date<today,due=p.due_date===today;
 items.push({id:'payment:'+p.id+':'+p.due_date+':'+(late?'late':due?'today':'soon'),kind:'billing',title:late?'Mensalidade em atraso':due?'Mensalidade vence hoje':'Vencimento da mensalidade',message:'Vencimento em '+p.due_date.split('-').reverse().join('/')+' · '+Number(p.expected_amount||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}),date:p.due_date+'T12:00:00Z',route:'settings'});}
 return items.sort((a,b)=>Number(b.kind==='billing')-Number(a.kind==='billing')||b.date.localeCompare(a.date)).slice(0,100);
}
function createNotifications({db,trainings,isOwner}){return async user=>{
 const failed=[],sources=await Promise.allSettled([Promise.resolve().then(()=>trainings(user)),(async()=>{
 if(user.role!=='supervisor'&&!await isOwner(user.organizationId,user.id))return [];
 const subscriptions=await db.from('subscriptions').select('id').eq('organization_id',user.organizationId).in('status',['active','past_due','suspended']);if(subscriptions.error)throw Error();
 const ids=(subscriptions.data||[]).map(x=>x.id);if(!ids.length)return [];
 const result=await db.from('payments').select('id,due_date,expected_amount,status').in('subscription_id',ids).in('status',['pending','overdue']).lte('due_date',day(new Date(Date.now()+7*86400000))).order('due_date').limit(100);if(result.error)throw Error();return result.data||[];
 })()]);
 sources.forEach((r,i)=>{if(r.status==='rejected')failed.push(i?'Cobranças':'Treinamentos');});
 return {scope:user.organizationId+':'+user.id,items:buildNotifications({trainings:sources[0].status==='fulfilled'?sources[0].value:[],payments:sources[1].status==='fulfilled'?sources[1].value:[]}),failed};
};}
module.exports={buildNotifications,createNotifications};
