 'use strict';
const closed=new Set(['fechamento','fechado','venda','vendido','cliente','ganho']);
const inactive=new Set([...closed,'arquivado','lixeira','venda_perdida','perdida']);
const clean=value=>String(value||'').slice(0,160);
function money(value){if(typeof value==='number')return Number.isFinite(value)?value:0;let text=String(value??'').replace(/[^0-9,.-]/g,'');if(text.includes(','))text=text.replace(/\./g,'').replace(',','.');return Number.isFinite(Number(text))?Number(text):0;}
const day=value=>{const d=new Date(value);return Number.isFinite(+d)?d.toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'}):'';};
function summarize(user,{users=[],leads=[],sales=[],receivables=[]},now=new Date()){
 const month=day(now).slice(0,7),today=day(now),supervisor=user.role==='supervisor';
 const team=supervisor?users.filter(x=>x.role==='broker'&&x.status==='active'):[];
 const owners=new Set([user.id,...team.map(x=>x.id)]);
 const visible=leads.filter(x=>owners.has(x.brokerUserId));
 const ledger=supervisor?sales:[];
 const linked=new Set(ledger.filter(x=>x.source_kind==='lead_closing').map(x=>String(x.source_id)));
 const contracts=[...ledger.filter(x=>x.status!=='cancelled').map(x=>({client:clean(x.client_name),product:clean(x.product_name),seller:clean(x.seller_name),sellerId:x.seller_user_id,amount:money(x.sale_amount),date:x.closed_at||null,source:'Financeiro'})),...visible.filter(x=>closed.has(x.status)&&!linked.has(String(x.id))).map(x=>({client:clean(x.nome||x.pushName),product:clean(x.planoInteresse||x.planoAtual),seller:clean(x.brokerName),sellerId:x.brokerUserId,amount:money(x.valorNegocio||x.valor),date:x.closedAt||null,source:'Fechamento no CRM'}))];
 const current=contracts.filter(x=>x.date&&day(x.date).startsWith(month));
 const total=rows=>Math.round(rows.reduce((n,x)=>n+x.amount,0)*100)/100;
 const ranking=team.map(x=>({name:clean(x.name),openOpportunities:visible.filter(l=>l.brokerUserId===x.id&&!inactive.has(l.status)).length,salesThisMonth:current.filter(c=>c.sellerId===x.id).length,valueThisMonth:total(current.filter(c=>c.sellerId===x.id))})).sort((a,b)=>b.valueThisMonth-a.valueThisMonth||b.salesThisMonth-a.salesThisMonth);
 const max=contracts.reduce((max,x)=>Math.max(max,x.amount),0);
 const best=contracts.filter(x=>x.amount===max&&max>0);
 return {asOf:now.toISOString(),scope:supervisor?'Financeiro da sua corretora e fechamentos do CRM próprios e dos corretores ativos':'Fechamentos do seu próprio CRM',sources:['CRM',...(supervisor?['Financeiro']:[])],period:month,
  sales:{count:contracts.length,total:total(contracts),monthCount:current.length,monthValue:total(current),withoutClosingDate:contracts.filter(x=>!x.date).length,withoutPositiveValue:contracts.filter(x=>x.amount<=0).length,highest:best.slice(0,5),highestTies:best.length,openOpportunities:visible.filter(x=>!inactive.has(x.status)).length},
  ...(supervisor?{team:{count:team.length,members:ranking.slice(0,100),rankingByValue:ranking.slice(0,5),listed:Math.min(team.length,100)},finance:{pending:receivables.filter(x=>x.status==='pending').reduce((n,x)=>n+money(x.net_amount),0),overdue:receivables.filter(x=>x.status==='pending'&&x.due_date<today).reduce((n,x)=>n+money(x.net_amount),0),receivedThisMonth:receivables.filter(x=>x.status==='paid'&&x.paid_at&&day(x.paid_at).startsWith(month)).reduce((n,x)=>n+money(x.paid_amount),0)}}:{}),
  notes:'Valores de venda não são comissão ou recebimento. Maior contrato considera todo o histórico das fontes consultadas, sem filtro mensal. Datas ausentes não são inferidas. Não inclui registros de outras corretoras ou fontes não listadas.'};
}
function createContext({db,legacy}){
 async function rows(table,columns,user,configure=q=>q){let output=[];for(let page=0;page<100;page++){const {data,error}=await configure(db.from(table).select(columns).eq('organization_id',user.organizationId)).order('id').range(page*1000,page*1000+999);if(error)throw Error('context unavailable');output.push(...(data||[]));if(!data||data.length<1000)return output;}throw Error('context too large');}
 return async user=>{
  const supervisor=user.role==='supervisor';
  const [users,leads,sales,receivables]=await Promise.all([
   supervisor?rows('users','id,name,role,status',user,q=>q.eq('role','broker').eq('status','active')):[],
   legacy.organizationLeads(user.organizationId),
   supervisor?rows('finance_sales','id,source_kind,source_id,client_name,product_name,seller_name,seller_user_id,sale_amount,closed_at,status',user):[],
   supervisor?rows('finance_receivables','id,status,net_amount,due_date,paid_at,paid_amount',user):[]
  ]);
  return summarize(user,{users,leads,sales,receivables});
 };
}
module.exports={createContext,summarize};
