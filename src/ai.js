import OpenAI from "openai";
function getClient(){
  const apiKey=process.env.OPENAI_API_KEY;
  if(!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  return new OpenAI({apiKey});
}
export async function aiDecision(payload){
  const client=getClient();
  const response=await client.responses.create({
    model:process.env.OPENAI_MODEL||"gpt-5.6-luna",
    instructions:"You are an XAUUSD SMC trading analyst. Technical evidence has 70% weight and fundamental evidence 30%. Never invent missing market data. Do not force a trade. Return ONLY valid JSON with keys decision (BUY, SELL, NO_TRADE), confidence (0-100), entry, stopLoss, takeProfit1, takeProfit2, technicalReason, fundamentalReason, invalidation. Use the supplied PREVIOUS CLOSED D1 candle as the daily context/bias and the supplied CLOSED H1, M15, and M5 market data for multi-timeframe SMC confirmation and execution. H1 defines intraday structure, M15 confirms the setup, and M5 is the execution timeframe. The daily bias is context, never permission to force a trade. Require liquidity/structure/OB-FVG/displacement/retest evidence from the supplied data. If timeframes conflict, the setup is incomplete, or evidence is weak, choose NO_TRADE. Risk levels must be derived from supplied price structure.",
    input:JSON.stringify(payload)
  });
  const text=response.output_text.trim().replace(/^\`\`\`json\s*/,"").replace(/\`\`\`$/,"");
  return JSON.parse(text);
}