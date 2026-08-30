import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { APIError } from "better-auth/api";
import { v } from "convex/values";
import type { DataModel } from "./_generated/dataModel";
import { components, internal } from "./_generated/api";
import { env, query } from "./_generated/server";
import authConfig from "./auth.config";
import { normalizeEmail } from "./lib/access";

export const authComponent = createClient<DataModel>(components.betterAuth);

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth({
    baseURL: env.CONVEX_SITE_URL,
    trustedOrigins: [env.WEB_SITE_URL, env.PWA_SITE_URL],
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const email = normalizeEmail(user.email);
            if (!("runQuery" in ctx))
              throw new APIError("FORBIDDEN", {
                message: "User provisioning is only available during sign-in",
              });
            const allowed: boolean = await ctx.runQuery(
              internal.authPolicy.isEmailAllowed,
              { email },
            );
            if (!allowed)
              throw new APIError("FORBIDDEN", {
                message: "This email address has not been invited",
              });
            return { data: { ...user, email } };
          },
        },
      },
    },
    plugins: [
      crossDomain({ siteUrl: env.PWA_SITE_URL }),
      convex({ authConfig }),
    ],
  });
};

export const getCurrentUser = query({
  args: {},
  returns: v.union(v.null(), v.any()),
  handler: async (ctx) => authComponent.getAuthUser(ctx),
});
