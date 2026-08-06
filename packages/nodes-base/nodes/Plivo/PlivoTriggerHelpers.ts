import { createHmac, timingSafeEqual } from 'crypto';
import type { IWebhookFunctions } from 'n8n-workflow';

export async function verifyPlivoSignature(this: IWebhookFunctions): Promise<boolean> {
	const credentials = await this.getCredentials<{
		authId: string;
		authToken: string;
	}>('plivoApi');

	if (!credentials?.authToken) {
		return true;
	}

	const req = this.getRequestObject();

	const nonceHeader = req.headers['x-plivo-signature-v3-nonce'];
	const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;

	const collect = (header: string | string[] | undefined): string[] =>
		(Array.isArray(header) ? header : header ? [header] : [])
			.flatMap((value) => value.split(','))
			.map((value) => value.trim())
			.filter(Boolean);
	const provided = [
		...collect(req.headers['x-plivo-signature-ma-v3']),
		...collect(req.headers['x-plivo-signature-v3']),
	];

	if (!nonce || provided.length === 0) {
		return false;
	}

	try {
		const webhookUrl = this.getNodeWebhookUrl('default') as string;
		const params = (this.getBodyData() ?? {}) as Record<string, unknown>;
		const keys = Object.keys(params).sort();

		let baseString: string;
		if (req.method === 'GET') {
			const query = keys
				.flatMap((key) => {
					const value = params[key];
					return Array.isArray(value)
						? [...value].sort().map((v) => `${key}=${v as string}`)
						: [`${key}=${value ?? ''}`];
				})
				.join('&');
			baseString = query ? `${webhookUrl}?${query}.${nonce}` : `${webhookUrl}.${nonce}`;
		} else {
			const paramString = keys
				.map((key) => {
					const value = params[key];
					return Array.isArray(value)
						? [...value].sort().map((v) => `${key}${v as string}`).join('')
						: `${key}${value ?? ''}`;
				})
				.join('');
			baseString = paramString
				? `${webhookUrl}?${paramString}.${nonce}`
				: `${webhookUrl}.${nonce}`;
		}

		const computedSignature = createHmac('sha256', credentials.authToken)
			.update(baseString)
			.digest('base64');

		const computedBuffer = Buffer.from(computedSignature);
		return provided.some((signature) => {
			const providedBuffer = Buffer.from(signature);
			return (
				computedBuffer.length === providedBuffer.length &&
				timingSafeEqual(computedBuffer, providedBuffer)
			);
		});
	} catch {
		return false;
	}
}

export function detectEventType(bodyData: Record<string, unknown>): string {
	if (bodyData.MessageUUID !== undefined) {
		if (bodyData.Status !== undefined) {
			return 'smsStatus';
		}
		if (bodyData.Text !== undefined) {
			return 'incomingSms';
		}
	}

	if (bodyData.CallUUID !== undefined) {
		const direction = typeof bodyData.Direction === 'string' ? bodyData.Direction : undefined;
		const callStatus = typeof bodyData.CallStatus === 'string' ? bodyData.CallStatus : undefined;

		if (direction === 'inbound' && callStatus === 'ringing') {
			return 'incomingCall';
		}

		if (callStatus !== undefined) {
			return 'callStatus';
		}
	}

	return 'unknown';
}
