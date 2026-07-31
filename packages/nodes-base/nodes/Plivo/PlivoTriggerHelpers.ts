import { createHmac, timingSafeEqual } from 'crypto';
import type { IWebhookFunctions } from 'n8n-workflow';

/**
 * Verify X-Plivo-Signature-V3 header for incoming webhooks.
 *
 * Algorithm:
 * 1. Get X-Plivo-Signature-V3 and X-Plivo-Signature-V3-Nonce headers
 * 2. Construct base string: webhookUrl, then for POST the parameters in
 *    key-sorted order (each as key + value, no separators), then the nonce
 * 3. Compute HMAC-SHA256 using Auth Token as key, base64 encoded
 * 4. Compare against each comma-separated provided signature with timing-safe equality
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

	const signatureHeader = req.headers['x-plivo-signature-v3'];
	const nonceHeader = req.headers['x-plivo-signature-v3-nonce'];

	// Headers can be string | string[] | undefined, extract first value if array
	const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
	const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;

	if (!signature || !nonce) {
		return false;
	}

	try {
		const webhookUrl = this.getNodeWebhookUrl('default') as string;

		// Plivo V3: the signed base string is the request URL with the POST
		// parameters appended in key-sorted order (each as key + value, no
		// separators), followed by the nonce; HMAC-SHA256 with the auth token,
		// base64-encoded.
		const params = (this.getBodyData() ?? {}) as Record<string, unknown>;
		const sortedParams = Object.keys(params)
			.sort()
			.map((key) => `${key}${params[key] as string}`)
			.join('');
		const baseString = req.method === 'GET' ? webhookUrl + nonce : webhookUrl + sortedParams + nonce;

		const computedSignature = createHmac('sha256', credentials.authToken)
			.update(baseString)
			.digest('base64');

		const computedBuffer = Buffer.from(computedSignature);
		return signature.split(',').some((provided) => {
			const providedBuffer = Buffer.from(provided.trim());
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
