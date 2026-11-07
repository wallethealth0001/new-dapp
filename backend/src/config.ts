import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const schema = z.object({
  BNB_MAINNET_RPC_URL: z.string().url(),
  BNB_MAINNET_RPC_FALLBACK_URL: z.string().url().default("https://bsc-rpc.publicnode.com"),
  EXECUTOR_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional().or(z.literal("")),
  ALLOWANCE_SPENDER_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  USDT_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  BACKEND_PORT: z.coerce.number().default(4000),
  MONITOR_START_BLOCK: z.coerce.number().int().nonnegative().default(0),
  NETWORK_NAME: z.string().default("BNB Smart Chain"),
  CHAIN_ID: z.coerce.number().default(56).refine((value) => value === 56, "Only BNB Smart Chain (chain ID 56) is supported"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().trim().optional().or(z.literal("")),
  TELEGRAM_CHAT_ID: z.string().trim().optional().or(z.literal("")),
  ADMIN_1_USERNAME: z.string().min(1),
  ADMIN_1_PASSWORD: z.string().min(12),
  ADMIN_2_USERNAME: z.string().min(1),
  ADMIN_2_PASSWORD: z.string().min(12)
}).superRefine((value, context) => {
  if (value.ADMIN_1_USERNAME === value.ADMIN_2_USERNAME) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ADMIN_2_USERNAME"],
      message: "Admin usernames must be distinct"
    });
  }
  if (value.USDT_ADDRESS.toLowerCase() === value.ALLOWANCE_SPENDER_ADDRESS.toLowerCase()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ALLOWANCE_SPENDER_ADDRESS"],
      message: "The token contract and allowance spender must be different addresses"
    });
  }
  if (Boolean(value.TELEGRAM_BOT_TOKEN) !== Boolean(value.TELEGRAM_CHAT_ID)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["TELEGRAM_CHAT_ID"],
      message: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be configured together"
    });
  }
});

export const config = schema.parse(process.env);