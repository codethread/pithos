export const sql = (strings: TemplateStringsArray, ...values: readonly unknown[]): string =>
	String.raw({ raw: strings }, ...values);
