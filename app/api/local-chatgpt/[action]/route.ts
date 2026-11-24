export const runtime="nodejs";
export async function GET(...args: unknown[]){void args;return Response.json({error:{code:"SOURCE_REMOVED",message:"订阅通道已停用，请使用 AI 设置。"}},{status:410});}
export const POST=GET;
