import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

// ============================================================
// Multi-app key resolution
// Все ключи 30 приложений хранятся в ОДНОМ секрете Cloudflare
// с именем ADAPTY_APP_KEYS, значение — JSON-объект вида:
//   {"App One": "secret_live_...", "App Two": "secret_live_...", ...}
// Это вместо 30 отдельных секретов — их пришлось бы заводить
// вручную через дашборд, что при масштабе 30 штук — верный
// способ повторить всю прошлую эпопею с одним ключом.
// ============================================================
// Cloudflare's dashboard "JSON" variable type delivers an ALREADY-PARSED
// object to env (not a string) — while a "Text"/"Secret" type holding JSON
// text delivers a raw string that still needs JSON.parse. Handle both.
function getAdaptyKeys(env: any): Record<string, string> {
	const raw = env?.ADAPTY_APP_KEYS;
	if (raw && typeof raw === "object") {
		return raw as Record<string, string>;
	}
	if (typeof raw === "string" && raw.length > 0) {
		try {
			return JSON.parse(raw);
		} catch {
			return {};
		}
	}
	return {};
}

// Диагностика: почему available_apps может оказаться пустым —
// переменная не задана вообще, задана пустой строкой, не парсится как JSON,
// либо (см. выше) пришла уже готовым объектом от типа "JSON" в Cloudflare.
// Не палит сами ключи — только длину/превью первых символов и факт наличия.
function diagnoseAdaptyAppKeys(env: any) {
	const raw = env?.ADAPTY_APP_KEYS;
	if (raw && typeof raw === "object") {
		return {
			adapty_app_keys_present: true,
			binding_shape: "object (Cloudflare JSON var type — уже распарсено)",
			apps: Object.keys(raw),
		};
	}
	const present = typeof raw === "string" && raw.length > 0;
	if (!present) {
		return {
			adapty_app_keys_present: false,
			binding_shape: typeof raw,
			apps: [],
		};
	}
	let jsonParseError: string | null = null;
	let apps: string[] = [];
	try {
		apps = Object.keys(JSON.parse(raw));
	} catch (e: any) {
		jsonParseError = String(e?.message ?? e);
	}
	return {
		adapty_app_keys_present: true,
		binding_shape: "string (Text/Secret var type — распарсено вручную)",
		adapty_app_keys_length: raw.length,
		adapty_app_keys_starts_with: raw.slice(0, 15),
		adapty_app_keys_ends_with: raw.slice(-15),
		json_parse_error: jsonParseError,
		apps,
	};
}

function appNotConfiguredResult(env: any, app: string) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(
					{
						error: `Приложение "${app}" не найдено в ADAPTY_APP_KEYS`,
						diagnostics: diagnoseAdaptyAppKeys(env),
					},
					null,
					2,
				),
			},
		],
	};
}

// ============================================================
// Shared response handling — никогда не падает на не-JSON ответе,
// всегда показывает HTTP-статус.
// ============================================================
async function describeAdaptyResponse(res: Response) {
	const raw = await res.text();
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// not JSON — fall back to raw text below
	}
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(
					{ http_status: res.status, ok: res.ok, body: parsed ?? raw },
					null,
					2,
				),
			},
		],
	};
}

// POST-запрос к api-admin.adapty.io (все /metrics/* и /exports/placements/ эндпоинты)
async function postToAdapty(env: any, app: string, path: string, body: unknown) {
	const key = getAdaptyKeys(env)[app];
	if (!key) return appNotConfiguredResult(env, app);
	const res = await fetch(`https://api-admin.adapty.io${path}`, {
		method: "POST",
		headers: {
			Authorization: `Api-Key ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	return describeAdaptyResponse(res);
}

// ============================================================
// Общие поля фильтров (MetricsFilters из спеки Adapty),
// используются в analytics/cohort/conversion/funnel/ltv/retention
// ============================================================
const metricsFilterFields = {
	date_from: z.string().describe("Дата начала периода, YYYY-MM-DD"),
	date_to: z.string().describe("Дата конца периода, YYYY-MM-DD"),
	compare_date_from: z
		.string()
		.optional()
		.describe("Начало периода сравнения, YYYY-MM-DD (опционально)"),
	compare_date_to: z
		.string()
		.optional()
		.describe("Конец периода сравнения, YYYY-MM-DD (опционально)"),
	country: z
		.array(z.string())
		.optional()
		.describe('Фильтр по странам, 2-буквенный код, например ["us","de"]'),
	store: z
		.array(z.string())
		.optional()
		.describe('Фильтр по стору, например ["app_store","play_store"]'),
	store_product_id: z
		.array(z.string())
		.optional()
		.describe("Фильтр по ID продукта в сторе"),
	duration: z.array(z.string()).optional().describe("Длительность подписки"),
	attribution_source: z
		.array(z.string())
		.optional()
		.describe("Источник атрибуции, например appsflyer"),
	attribution_status: z
		.array(z.string())
		.optional()
		.describe("organic / non-organic"),
	attribution_channel: z
		.array(z.string())
		.optional()
		.describe("Маркетинговый канал"),
	attribution_campaign: z
		.array(z.string())
		.optional()
		.describe("Маркетинговая кампания"),
	attribution_adgroup: z.array(z.string()).optional().describe("Рекламная группа"),
	attribution_adset: z.array(z.string()).optional().describe("Рекламный сет"),
	attribution_creative: z.array(z.string()).optional().describe("Креатив"),
	offer_category: z.array(z.string()).optional().describe("Категория оффера"),
	offer_type: z.array(z.string()).optional().describe("Тип оффера"),
	offer_id: z.array(z.string()).optional().describe("ID конкретного оффера"),
};

const optionalFilterKeys = [
	"country",
	"store",
	"store_product_id",
	"duration",
	"attribution_source",
	"attribution_status",
	"attribution_channel",
	"attribution_campaign",
	"attribution_adgroup",
	"attribution_adset",
	"attribution_creative",
	"offer_category",
	"offer_type",
	"offer_id",
] as const;

function buildFilters(a: Record<string, unknown>) {
	const filters: Record<string, unknown> = { date: [a.date_from, a.date_to] };
	if (a.compare_date_from && a.compare_date_to) {
		filters.compare_date = [a.compare_date_from, a.compare_date_to];
	}
	for (const key of optionalFilterKeys) {
		if (a[key] !== undefined) filters[key] = a[key];
	}
	return filters;
}

// ============================================================
// MCP agent
// ============================================================
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Adapty Analytics (multi-app)",
		version: "1.0.0",
	});

	async init() {
		// Simple addition tool (из исходного шаблона)
		this.server.registerTool(
			"add",
			{ inputSchema: { a: z.number(), b: z.number() } },
			async ({ a, b }) => ({
				content: [{ type: "text", text: String(a + b) }],
			}),
		);

		// Calculator tool (из исходного шаблона)
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
									{ type: "text", text: "Error: Cannot divide by zero" },
								],
							};
						result = a / b;
						break;
				}
				return { content: [{ type: "text", text: String(result) }] };
			},
		);

		// ---------- list_apps ----------
		this.server.registerTool(
			"list_apps",
			{
				description:
					"Список названий приложений Adapty, настроенных в ADAPTY_APP_KEYS (без самих ключей)",
			},
			async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify(diagnoseAdaptyAppKeys(this.env), null, 2),
					},
				],
			}),
		);

		// ---------- get_subscriber_profile ----------
		this.server.registerTool(
			"get_subscriber_profile",
			{
				description:
					"Профиль подписчика Adapty (подписки, покупки, revenue) по customer_user_id, для конкретного приложения",
				inputSchema: {
					app: z.string().describe("Название приложения (см. list_apps)"),
					customer_user_id: z
						.string()
						.describe("customer_user_id из вашего приложения"),
				},
			},
			async ({ app, customer_user_id }) => {
				const key = getAdaptyKeys(this.env)[app];
				if (!key) return appNotConfiguredResult(this.env, app);
				const res = await fetch(
					"https://api.adapty.io/api/v2/server-side-api/profile/",
					{
						method: "GET",
						headers: {
							Authorization: `Api-Key ${key}`,
							"adapty-customer-user-id": customer_user_id,
						},
					},
				);
				return describeAdaptyResponse(res);
			},
		);

		// ---------- get_analytics (revenue, mrr, arr, installs, подписки, триалы, ...) ----------
		this.server.registerTool(
			"get_analytics",
			{
				description:
					"Универсальный график аналитики Adapty по одному приложению: revenue, mrr, arr, arppu, arpu, installs, активные/новые/отменённые/истёкшие подписки и триалы, grace period, billing issues, возвраты",
				inputSchema: {
					app: z.string().describe("Название приложения (см. list_apps)"),
					chart_id: z
						.enum([
							"revenue",
							"mrr",
							"arr",
							"arppu",
							"arpu",
							"installs",
							"subscriptions_active",
							"subscriptions_new",
							"subscriptions_renewal_cancelled",
							"subscriptions_expired",
							"trials_active",
							"trials_new",
							"trials_renewal_cancelled",
							"trials_expired",
							"grace_period",
							"billing_issue",
							"refund_events",
							"refund_money",
							"non_subscriptions",
						])
						.describe("Какой график нужен"),
					period_unit: z
						.enum(["day", "week", "month", "quarter", "year"])
						.optional()
						.describe("Гранулярность, по умолчанию month"),
					date_type: z
						.enum(["purchase_date", "profile_install_date"])
						.optional(),
					segmentation: z
						.string()
						.optional()
						.describe("Поле для сегментации, например attribution_campaign"),
					...metricsFilterFields,
				},
			},
			async ({ app, chart_id, period_unit, date_type, segmentation, ...filterArgs }) => {
				const body: Record<string, unknown> = {
					chart_id,
					filters: buildFilters(filterArgs),
				};
				if (period_unit) body.period_unit = period_unit;
				if (date_type) body.date_type = date_type;
				if (segmentation) body.segmentation = segmentation;
				return postToAdapty(
					this.env,
					app,
					"/api/v1/client-api/metrics/analytics/",
					body,
				);
			},
		);

		// ---------- get_cohort_data ----------
		this.server.registerTool(
			"get_cohort_data",
			{
				description:
					"Когортный анализ Adapty: revenue/arppu/arpu/arpas/подписчики/подписки по когортам, с опциональным прогнозом",
				inputSchema: {
					app: z.string().describe("Название приложения (см. list_apps)"),
					period_unit: z
						.enum(["day", "week", "month", "quarter", "year"])
						.optional(),
					period_type: z.enum(["renewals", "days"]).optional(),
					value_type: z.enum(["absolute", "relative"]).optional(),
					value_field: z
						.enum(["revenue", "arppu", "arpu", "arpas", "subscribers", "subscriptions"])
						.optional(),
					accounting_type: z
						.enum(["revenue", "proceeds", "net_revenue"])
						.optional(),
					prediction_months: z
						.union([
							z.literal(3),
							z.literal(6),
							z.literal(9),
							z.literal(12),
							z.literal(18),
							z.literal(24),
						])
						.optional()
						.describe("Горизонт прогноза в месяцах"),
					...metricsFilterFields,
				},
			},
			async ({
				app,
				period_unit,
				period_type,
				value_type,
				value_field,
				accounting_type,
				prediction_months,
				...filterArgs
			}) => {
				const body: Record<string, unknown> = { filters: buildFilters(filterArgs) };
				if (period_unit) body.period_unit = period_unit;
				if (period_type) body.period_type = period_type;
				if (value_type) body.value_type = value_type;
				if (value_field) body.value_field = value_field;
				if (accounting_type) body.accounting_type = accounting_type;
				if (prediction_months !== undefined)
					body.prediction_months = prediction_months;
				return postToAdapty(this.env, app, "/api/v1/client-api/metrics/cohort/", body);
			},
		);

		// ---------- get_conversion_data ----------
		this.server.registerTool(
			"get_conversion_data",
			{
				description:
					"Конверсия между состояниями подписки (например из триала в оплаченную, из 1 месяца в 6+)",
				inputSchema: {
					app: z.string().describe("Название приложения (см. list_apps)"),
					from_period: z
						.string()
						.nullable()
						.describe('Начальное состояние, например "1" или "trial"'),
					to_period: z.string().describe('Целевое состояние, например "6+"'),
					period_unit: z
						.enum(["day", "week", "month", "quarter", "year"])
						.optional(),
					date_type: z
						.enum(["purchase_date", "profile_install_date"])
						.optional(),
					segmentation: z.string().optional(),
					...metricsFilterFields,
				},
			},
			async ({
				app,
				from_period,
				to_period,
				period_unit,
				date_type,
				segmentation,
				...filterArgs
			}) => {
				const body: Record<string, unknown> = {
					from_period,
					to_period,
					filters: buildFilters(filterArgs),
				};
				if (period_unit) body.period_unit = period_unit;
				if (date_type) body.date_type = date_type;
				if (segmentation) body.segmentation = segmentation;
				return postToAdapty(
					this.env,
					app,
					"/api/v1/client-api/metrics/conversion/",
					body,
				);
			},
		);

		// ---------- get_funnel_data ----------
		this.server.registerTool(
			"get_funnel_data",
			{
				description:
					"Воронка: продвижение пользователей по этапам (install → paywall → покупка и т.д.)",
				inputSchema: {
					app: z.string().describe("Название приложения (см. list_apps)"),
					period_unit: z
						.enum(["day", "week", "month", "quarter", "year"])
						.optional(),
					show_value_as: z.enum(["absolute", "relative", "both"]).optional(),
					segmentation: z.string().optional(),
					...metricsFilterFields,
				},
			},
			async ({ app, period_unit, show_value_as, segmentation, ...filterArgs }) => {
				const body: Record<string, unknown> = { filters: buildFilters(filterArgs) };
				if (period_unit) body.period_unit = period_unit;
				if (show_value_as) body.show_value_as = show_value_as;
				if (segmentation) body.segmentation = segmentation;
				return postToAdapty(this.env, app, "/api/v1/client-api/metrics/funnel/", body);
			},
		);

		// ---------- get_ltv_data ----------
		this.server.registerTool(
			"get_ltv_data",
			{
				description:
					"Lifetime Value (LTV): revenue/proceeds/net_revenue на подписчика за период",
				inputSchema: {
					app: z.string().describe("Название приложения (см. list_apps)"),
					period_unit: z
						.enum(["day", "week", "month", "quarter", "year"])
						.optional(),
					period_type: z.enum(["renewals", "days"]).optional(),
					segmentation: z.string().optional(),
					...metricsFilterFields,
				},
			},
			async ({ app, period_unit, period_type, segmentation, ...filterArgs }) => {
				const body: Record<string, unknown> = { filters: buildFilters(filterArgs) };
				if (period_unit) body.period_unit = period_unit;
				if (period_type) body.period_type = period_type;
				if (segmentation) body.segmentation = segmentation;
				return postToAdapty(this.env, app, "/api/v1/client-api/metrics/ltv/", body);
			},
		);

		// ---------- get_retention_data ----------
		this.server.registerTool(
			"get_retention_data",
			{
				description: "Retention: удержание пользователей/подписчиков во времени",
				inputSchema: {
					app: z.string().describe("Название приложения (см. list_apps)"),
					period_unit: z
						.enum(["day", "week", "month", "quarter", "year"])
						.optional(),
					segmentation: z.string().optional(),
					use_trial: z.boolean().optional().describe("Учитывать ли триалы"),
					...metricsFilterFields,
				},
			},
			async ({ app, period_unit, segmentation, use_trial, ...filterArgs }) => {
				const body: Record<string, unknown> = { filters: buildFilters(filterArgs) };
				if (period_unit) body.period_unit = period_unit;
				if (segmentation) body.segmentation = segmentation;
				if (use_trial !== undefined) body.use_trial = use_trial;
				return postToAdapty(
					this.env,
					app,
					"/api/v1/client-api/metrics/retention/",
					body,
				);
			},
		);

		// ---------- get_placement_info ----------
		this.server.registerTool(
			"get_placement_info",
			{
				description:
					"Информация о пейволлах/онбордингах: аудитории, сегменты, A/B-тесты",
				inputSchema: {
					app: z.string().describe("Название приложения (см. list_apps)"),
					placement_type: z.enum(["paywall", "onboarding"]),
				},
			},
			async ({ app, placement_type }) => {
				return postToAdapty(this.env, app, "/api/v1/client-api/exports/placements/", {
					filters: { placement_type },
				});
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
