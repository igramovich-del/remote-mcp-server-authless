import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

// Helper: safely read an Adapty response and show what actually came back,
// plus a masked preview of the key we sent, without ever exposing the full secret.
async function describeAdaptyResponse(res: Response, keyUsed: string | undefined) {
	const raw = await res.text();
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// not JSON, that's fine — we show the raw text below
	}
	const keyPreview = keyUsed
		? `${keyUsed.slice(0, 8)}...${keyUsed.slice(-4)} (length ${keyUsed.length})`
		: "ADAPTY_API_KEY is undefined/empty";
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(
					{
						http_status: res.status,
						ok: res.ok,
						key_used: keyPreview,
						body: parsed ?? raw,
					},
					null,
					2,
				),
			},
		],
	};
}

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Authless Calculator",
		version: "1.0.0",
	});

	async init() {
		// Simple addition tool
		this.server.registerTool(
			"add",
			{ inputSchema: { a: z.number(), b: z.number() } },
			async ({ a, b }) => ({
				content: [{ type: "text", text: String(a + b) }],
			}),
		);

		// Calculator tool with multiple operations
		this.server.registerTool(
			"calculate",
			{
				inputSchema: {
					operation: z.enum(["add", "subtract", "multiply", "divide"]),
					a: z.number(),
					b: z.number(),
				},
			},
			async ({ operation, a, b }) => {
				let result: number;
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "subtract":
						result = a - b;
						break;
					case "multiply":
						result = a * b;
						break;
					case "divide":
						if (b === 0)
							return {
								content: [
									{
										type: "text",
										text: "Error: Cannot divide by zero",
									},
								],
							};
						result = a / b;
						break;
				}
				return { content: [{ type: "text", text: String(result) }] };
			},
		);

		// Adapty: профиль подписчика по customer_user_id
		this.server.registerTool(
			"get_subscriber_profile",
			{
				description:
					"Профиль подписчика Adapty (подписки, покупки, revenue) по customer_user_id",
				inputSchema: {
					customer_user_id: z
						.string()
						.describe("customer_user_id из вашего приложения"),
				},
			},
			async ({ customer_user_id }) => {
				const res = await fetch(
					"https://api.adapty.io/api/v2/server-side-api/profile/",
					{
						method: "GET",
						headers: {
							Authorization: `Api-Key ${this.env.ADAPTY_API_KEY}`,
							"adapty-customer-user-id": customer_user_id,
						},
					},
				);
				return describeAdaptyResponse(res, this.env.ADAPTY_API_KEY);
			},
		);

		// Adapty: аналитика revenue за период
		this.server.registerTool(
			"get_revenue_analytics",
			{
				description: "Аналитика revenue из Adapty за период",
				inputSchema: {
					date_from: z.string().describe("Дата начала, YYYY-MM-DD"),
					date_to: z.string().describe("Дата конца, YYYY-MM-DD"),
					period_unit: z.enum(["day", "week", "month"]).default("week"),
				},
			},
			async ({ date_from, date_to, period_unit }) => {
				const res = await fetch(
					"https://api-admin.adapty.io/api/v1/client-api/metrics/analytics/",
					{
						method: "POST",
						headers: {
							Authorization: `Api-Key ${this.env.ADAPTY_API_KEY}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							chart_id: "revenue",
							filters: { date: [date_from, date_to] },
							period_unit,
						}),
					},
				);
				return describeAdaptyResponse(res, this.env.ADAPTY_API_KEY);
			},
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
