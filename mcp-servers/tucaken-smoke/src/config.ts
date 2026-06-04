/** @format */
export const DEV_TARGET = { account: '771826808455', region: 'eu-west-1', db: 'tucaken' } as const;
export const LOG_RETAIN = Math.max(1, parseInt(process.env.SMOKE_LOG_RETAIN ?? '20', 10));
