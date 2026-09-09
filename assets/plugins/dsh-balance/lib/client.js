window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// ── 价格设置（V4.2，设置页 settings.section「价格设置」）──────────
		// 自定义各模型 Token 价格（¥/百万 token，高峰/空闲两档 × 缓存未命中/
		// 命中/输出三字段），覆盖 settings.json 的 balancePrices.<model>，
		// 由桌面壳 balancePrices API 读取、保存和恢复默认价格。
		const PRICE_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"];
		const PRICE_LABELS = {
			"deepseek-v4-flash": "V4 Flash",
			"deepseek-v4-pro": "V4 Pro",
			"deepseek-chat": "DeepSeek Chat",
			"deepseek-reasoner": "DeepSeek Reasoner",
		};
		const PRICE_FIELDS = [
			["cacheMiss", "未命中缓存"],
			["cacheHit", "命中缓存"],
			["output", "输出"],
		];
		const TIERS = [
			["peak", "高峰价"],
			["offpeak", "空闲价"],
		];

		function priceBridge() {
			const b = window.dshDesktop && window.dshDesktop.balancePrices;
			return b || null;
		}

		function PricingSection() {
			const [model, setModel] = react.useState(PRICE_MODELS[0]);
			const [form, setForm] = react.useState(null);
			const [dirty, setDirty] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [status, setStatus] = react.useState(null);
			const [loadError, setLoadError] = react.useState(null);

			const load = (m) => {
				const b = priceBridge();
				if (!b) {
					setLoadError("价格设置桥接不可用（请确认已更新到最新版 DSH Desktop）");
					return;
				}
				setBusy(true);
				setLoadError(null);
				setStatus(null);
				b.get(m).then((res) => {
					setBusy(false);
					if (!res || !res.ok) {
						setLoadError(String((res && res.error) || "读取失败"));
						return;
					}
					const src = res.current || res.defaults || {};
					setForm({
						peak: { ...(src.peak || {}) },
						offpeak: { ...(src.offpeak || {}) },
					});
					setDirty(false);
				}).catch((err) => {
					setBusy(false);
					setLoadError(String((err && err.message) || err));
				});
			};

			react.useEffect(() => { load(model); }, [model]);

			const setField = (tier, key, raw) => {
				setForm((f) => (f ? { ...f, [tier]: { ...f[tier], [key]: raw } } : f));
				setDirty(true);
				setStatus(null);
			};

			const save = () => {
				const b = priceBridge();
				if (!b || !form) return;
				const parsed = { peak: {}, offpeak: {} };
				for (const [tier] of TIERS) {
					for (const [key] of PRICE_FIELDS) {
						const v = Number(form[tier][key]);
						if (!Number.isFinite(v) || v < 0 || v > 1000) {
							setStatus({ kind: "err", text: "价格必须是 0~1000 的数字" });
							return;
						}
						parsed[tier][key] = v;
					}
				}
				setBusy(true);
				setStatus(null);
				b.set(model, parsed).then((res) => {
					setBusy(false);
					if (res && res.ok) {
						setDirty(false);
						setStatus({ kind: "ok", text: "已保存，费用估算已更新" });
					} else {
						setStatus({ kind: "err", text: String((res && res.error) || "保存失败") });
					}
				}).catch((err) => {
					setBusy(false);
					setStatus({ kind: "err", text: String((err && err.message) || err) });
				});
			};

			const reset = () => {
				const b = priceBridge();
				if (!b || !form) return;
				setBusy(true);
				setStatus(null);
				b.reset(model).then((res) => {
					setBusy(false);
					if (res && res.ok) {
						load(model);
						setStatus({ kind: "ok", text: "已恢复默认价格" });
					} else {
						setStatus({ kind: "err", text: String((res && res.error) || "恢复失败") });
					}
				}).catch((err) => {
					setBusy(false);
					setStatus({ kind: "err", text: String((err && err.message) || err) });
				});
			};

			if (loadError) {
				return react_jsx_runtime.jsx("div", { className: "dsh-balance-pr err", children: loadError });
			}
			if (!form) {
				return react_jsx_runtime.jsx("div", { className: "dsh-balance-pr", children: "加载中…" });
			}
			const tierBox = (tier, title) => react_jsx_runtime.jsxs("div", {
				className: "dsh-balance-pr-tier",
				children: [
					react_jsx_runtime.jsx("div", { className: "dsh-balance-pr-tier-title", children: title }),
					PRICE_FIELDS.map(([key, label]) => react_jsx_runtime.jsxs("label", {
						className: "dsh-balance-pr-field",
						children: [
							react_jsx_runtime.jsx("span", { children: label }),
							react_jsx_runtime.jsx("input", {
								type: "number",
								min: 0,
								max: 1000,
								step: 0.05,
								disabled: busy,
								value: form[tier][key],
								onChange: (e) => setField(tier, key, e.target.value),
							}),
						],
					})),
				],
			});

			return react_jsx_runtime.jsxs("div", {
				className: "dsh-balance-pr",
				children: [
					react_jsx_runtime.jsx("div", { className: "dsh-balance-pr-hint", children: "自定义价格覆盖官方默认档（仅影响本机费用估算显示，单位：¥/百万 token）。" }),
					react_jsx_runtime.jsxs("div", {
						className: "dsh-balance-pr-models",
						children: PRICE_MODELS.map((m) => react_jsx_runtime.jsx("button", {
							type: "button",
							className: "dsh-balance-pr-model" + (m === model ? " on" : ""),
							onClick: () => setModel(m),
							children: PRICE_LABELS[m] || m,
						})),
					}),
					react_jsx_runtime.jsxs("div", {
						className: "dsh-balance-pr-grid",
						children: [tierBox("peak", "高峰价"), tierBox("offpeak", "空闲价")],
					}),
					react_jsx_runtime.jsxs("div", {
						className: "dsh-balance-pr-actions",
						children: [
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "dsh-balance-pr-btn primary",
								disabled: busy || !dirty,
								onClick: save,
								children: busy ? "处理中…" : "保存",
							}),
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "dsh-balance-pr-btn",
								disabled: busy,
								onClick: reset,
								children: "恢复默认",
							}),
							status ? react_jsx_runtime.jsx("span", { className: "dsh-balance-pr-status " + status.kind, children: status.text }) : null,
						],
					}),
				],
			});
		}

		const CSS = [
			".dsh-balance-pr{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:20px;color:var(--eac-widget-fg,var(--dsw-alias-label-secondary))}",
			".dsh-balance-pr.err{color:var(--dsw-alias-danger,#e5484d)}",
			".dsh-balance-pr-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-balance-pr-models{display:flex;flex-wrap:wrap;gap:6px}",
			".dsh-balance-pr-model{border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:999px;padding:2px 10px;font-size:12px;color:inherit;cursor:pointer;transition:color .15s,border-color .15s}",
			".dsh-balance-pr-model:hover{border-color:var(--dsw-alias-border-l3)}",
			".dsh-balance-pr-model.on{color:var(--dsw-alias-accent,#5e9cff);border-color:var(--dsw-alias-accent,#5e9cff)}",
			".dsh-balance-pr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}",
			".dsh-balance-pr-tier{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}",
			".dsh-balance-pr-tier-title{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-balance-pr-field{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}",
			".dsh-balance-pr-field input{width:110px;background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 8px;color:inherit;font-variant-numeric:tabular-nums;text-align:right}",
			".dsh-balance-pr-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dsh-balance-pr-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:6px;padding:4px 14px;font-size:12px;color:inherit;cursor:pointer}",
			".dsh-balance-pr-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}",
			".dsh-balance-pr-btn.primary{border-color:var(--dsw-alias-accent,#5e9cff);color:var(--dsw-alias-accent,#5e9cff)}",
			".dsh-balance-pr-btn:disabled{opacity:.45;cursor:default}",
			".dsh-balance-pr-status{font-size:12px}",
			".dsh-balance-pr-status.ok{color:#7fd6a0}",
			".dsh-balance-pr-status.err{color:var(--dsw-alias-danger,#e5484d)}"
		].join("");

		const TAG = "@deepseek-ai/dsh-balance/client.css";
		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG) + "]")) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-balance";
			tag.dataset.pluginCss = TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** Settings-only client; native balance services remain owned by the shell. */
		function apply(ctx) {
			ensureCss();
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "pricing",
				order: 23,
				label: () => "价格设置"
			}, PricingSection));
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
