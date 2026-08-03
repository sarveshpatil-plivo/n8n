import { createHmac, timingSafeEqual } from 'crypto';
import type { IWebhookFunctions } from 'n8n-workflow';

/**
 * Verify Plivo's V3 signature for incoming webhooks.
 *
 * Reproduces the base string from Plivo's official SDK (lib/utils/v3Security.js):
 * the request URL, then for a POST the parameters in key-sorted order concatenated
 * as key+value (prefixed with "?" when any exist), then "." then the nonce; a GET
 * appends the sorted params as a "key=value&" query string instead. HMAC-SHA256
 * with the Auth Token, base64-encoded.
 *
 * Plivo delivers this value in the X-Plivo-Signature-Ma-V3 header on application
 * (voice and messaging) webhooks — verified against real inbound SMS and call
 * requests. It also sends a plain X-Plivo-Signature-V3 header computed by a
 * different scheme, so both are accepted and a match against either passes.
 */
export async function verifyPlivoSignature(this: IWebhookFunctions): Promise<boolean> {
	const credentials = await this.getCredentials<{
		authId: string;
		authToken: string;
	}>('plivoApi');

	if (!credentials?.authToken) {
		return true; // No auth token provided, skip verification
	}

	const req = this.getRequestObject();

	const nonceHeader = req.headers['x-plivo-signature-v3-nonce'];
	const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;

	// Collect the candidate signatures from both V3 headers, splitting the
	// comma-separated lists Plivo may send.
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

/**
 * Detect the event type from the incoming webhook payload.
 */
export function detectEventType(bodyData: Record<string, unknown>): string {
	// Check for SMS-related events
	if (bodyData.MessageUUID !== undefined) {
		// SMS Delivery Status has Status field
		if (bodyData.Status !== undefined) {
			return 'smsStatus';
		}
		// Incoming SMS has Text field
		if (bodyData.Text !== undefined) {
			return 'incomingSms';
		}
	}

	// Check for Call-related events
	if (bodyData.CallUUID !== undefined) {
		const direction = typeof bodyData.Direction === 'string' ? bodyData.Direction : undefined;
		const callStatus = typeof bodyData.CallStatus === 'string' ? bodyData.CallStatus : undefined;

		// Incoming call: Direction is 'inbound' and status is 'ringing' or similar
		if (direction === 'inbound' && callStatus === 'ringing') {
			return 'incomingCall';
		}

		// Call status update: has CallStatus field
		if (callStatus !== undefined) {
			return 'callStatus';
		}
	}

	return 'unknown';
}
