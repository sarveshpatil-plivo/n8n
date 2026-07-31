import { createHmac } from 'crypto';

import { mock } from 'vitest-mock-extended';
import type { Mock } from 'vitest';
import type { IDataObject, IHookFunctions, INodeType, IWebhookFunctions } from 'n8n-workflow';

import { plivoApiRequest } from './GenericFunctions';
import { PlivoTrigger } from './PlivoTrigger.node';
import { detectEventType, verifyPlivoSignature } from './PlivoTriggerHelpers';

// Mock the helper functions
vi.mock('./PlivoTriggerHelpers', () => ({
	verifyPlivoSignature: vi.fn(),
	detectEventType: vi.fn(),
}));

vi.mock('./GenericFunctions', () => ({
	plivoApiRequest: vi.fn(),
}));

describe('PlivoTrigger Node', () => {
	let plivoTrigger: INodeType;
	let mockWebhookFunctions: ReturnType<typeof mock<IWebhookFunctions>>;
	let mockResponse: {
		status: Mock;
		send: Mock;
		json: Mock;
		end: Mock;
		setHeader: Mock;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		plivoTrigger = new PlivoTrigger();

		mockWebhookFunctions = mock<IWebhookFunctions>();

		mockResponse = {
			status: vi.fn().mockReturnThis(),
			send: vi.fn().mockReturnThis(),
			json: vi.fn().mockReturnThis(),
			end: vi.fn(),
			setHeader: vi.fn().mockReturnThis(),
		};

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockWebhookFunctions.getResponseObject.mockReturnValue(mockResponse as any);

		// Mock helpers.returnJsonArray
		mockWebhookFunctions.helpers = {
			returnJsonArray: vi.fn((data) => [{ json: data }]),
		} as unknown as IWebhookFunctions['helpers'];

		// Default: signature validation enabled and valid
		(verifyPlivoSignature as Mock).mockResolvedValue(true);
	});

	describe('webhook method - signature validation', () => {
		it('should reject request with invalid signature when validation is enabled', async () => {
			(verifyPlivoSignature as Mock).mockResolvedValue(false);
			(detectEventType as Mock).mockReturnValue('incomingSms');

			mockWebhookFunctions.getNodeParameter.mockImplementation((paramName: string) => {
				if (paramName === 'validateSignature') return true;
				if (paramName === 'events') return ['incomingSms'];
				return undefined;
			});

			mockWebhookFunctions.getBodyData.mockReturnValue({
				MessageUUID: 'msg-123',
				Text: 'Hello',
			});

			const result = await plivoTrigger.webhook!.call(mockWebhookFunctions);

			expect(mockResponse.status).toHaveBeenCalledWith(401);
			expect(mockResponse.send).toHaveBeenCalledWith('Unauthorized: Invalid signature');
			expect(result.noWebhookResponse).toBe(true);
		});

		it('should accept request with valid signature when validation is enabled', async () => {
			(verifyPlivoSignature as Mock).mockResolvedValue(true);
			(detectEventType as Mock).mockReturnValue('incomingSms');

			mockWebhookFunctions.getNodeParameter.mockImplementation((paramName: string) => {
				if (paramName === 'validateSignature') return true;
				if (paramName === 'events') return ['incomingSms'];
				return undefined;
			});

			const bodyData = {
				MessageUUID: 'msg-123',
				From: '+14155551234',
				To: '+14155555678',
				Text: 'Hello',
			};
			mockWebhookFunctions.getBodyData.mockReturnValue(bodyData);

			const result = await plivoTrigger.webhook!.call(mockWebhookFunctions);

			expect(result.workflowData).toBeDefined();
			expect(mockWebhookFunctions.helpers.returnJsonArray).toHaveBeenCalledWith({
				...bodyData,
				_eventType: 'incomingSms',
			});
		});

		it('should skip signature validation when disabled', async () => {
			(detectEventType as Mock).mockReturnValue('incomingSms');

			mockWebhookFunctions.getNodeParameter.mockImplementation((paramName: string) => {
				if (paramName === 'validateSignature') return false;
				if (paramName === 'events') return ['incomingSms'];
				return undefined;
			});

			const bodyData = {
				MessageUUID: 'msg-123',
				Text: 'Hello',
			};
			mockWebhookFunctions.getBodyData.mockReturnValue(bodyData);

			const result = await plivoTrigger.webhook!.call(mockWebhookFunctions);

			expect(verifyPlivoSignature).not.toHaveBeenCalled();
			expect(result.workflowData).toBeDefined();
		});
	});

	describe('webhook method - event filtering', () => {
		beforeEach(() => {
			(verifyPlivoSignature as Mock).mockResolvedValue(true);
		});

		it('should process incoming SMS when subscribed', async () => {
			(detectEventType as Mock).mockReturnValue('incomingSms');

			mockWebhookFunctions.getNodeParameter.mockImplementation((paramName: string) => {
				if (paramName === 'validateSignature') return true;
				if (paramName === 'events') return ['incomingSms'];
				return undefined;
			});

			const bodyData = {
				MessageUUID: 'msg-123',
				From: '+14155551234',
				To: '+14155555678',
				Text: 'Test message',
				Type: 'sms',
			};
			mockWebhookFunctions.getBodyData.mockReturnValue(bodyData);

			const result = await plivoTrigger.webhook!.call(mockWebhookFunctions);

			expect(result.workflowData).toBeDefined();
			expect(mockWebhookFunctions.helpers.returnJsonArray).toHaveBeenCalledWith({
				...bodyData,
				_eventType: 'incomingSms',
			});
		});

		it('should ignore events not subscribed to', async () => {
			(detectEventType as Mock).mockReturnValue('smsStatus');

			mockWebhookFunctions.getNodeParameter.mockImplementation((paramName: string) => {
				if (paramName === 'validateSignature') return true;
				if (paramName === 'events') return ['incomingSms']; // Only subscribed to incomingSms
				return undefined;
			});

			mockWebhookFunctions.getBodyData.mockReturnValue({
				MessageUUID: 'msg-123',
				Status: 'delivered',
			});

			const result = await plivoTrigger.webhook!.call(mockWebhookFunctions);

			// Should return empty result for unsubscribed events
			expect(result).toEqual({});
		});

		it('should process SMS delivery status when subscribed', async () => {
			(detectEventType as Mock).mockReturnValue('smsStatus');

			mockWebhookFunctions.getNodeParameter.mockImplementation((paramName: string) => {
				if (paramName === 'validateSignature') return true;
				if (paramName === 'events') return ['smsStatus'];
				return undefined;
			});

			const bodyData = {
				MessageUUID: 'msg-123',
				From: '+14155551234',
				To: '+14155555678',
				Status: 'delivered',
			};
			mockWebhookFunctions.getBodyData.mockReturnValue(bodyData);

			const result = await plivoTrigger.webhook!.call(mockWebhookFunctions);

			expect(result.workflowData).toBeDefined();
			expect(mockWebhookFunctions.helpers.returnJsonArray).toHaveBeenCalledWith({
				...bodyData,
				_eventType: 'smsStatus',
			});
		});

		it('redirects Plivo to the configured Answer URL and triggers the workflow', async () => {
			(detectEventType as Mock).mockReturnValue('incomingCall');

			mockWebhookFunctions.getNodeParameter.mockImplementation(
				(paramName: string, fallback?: unknown) => {
					if (paramName === 'validateSignature') return true;
					if (paramName === 'events') return ['incomingCall'];
					if (paramName === 'answerUrl') return 'https://example.com/answer';
					if (paramName === 'answerMethod') return 'GET';
					return fallback;
				},
			);

			const bodyData = {
				CallUUID: 'call-123',
				From: '+14155551234',
				To: '+14155555678',
				CallStatus: 'ringing',
				Direction: 'inbound',
			};
			mockWebhookFunctions.getBodyData.mockReturnValue(bodyData);

			const result = await plivoTrigger.webhook!.call(mockWebhookFunctions);

			// Redirects Plivo to the user's Answer URL for call control while triggering the workflow.
			expect(mockResponse.setHeader).toHaveBeenCalledWith('Content-Type', 'text/xml');
			expect(mockResponse.status).toHaveBeenCalledWith(200);
			expect(mockResponse.send).toHaveBeenCalledWith(
				'<Response><Redirect method="GET">https://example.com/answer</Redirect></Response>',
			);
			expect(result.noWebhookResponse).toBe(true);
			expect(result.workflowData).toBeDefined();
			expect(mockWebhookFunctions.helpers.returnJsonArray).toHaveBeenCalledWith({
				...bodyData,
				_eventType: 'incomingCall',
			});
		});

		it('should process call status update when subscribed', async () => {
			(detectEventType as Mock).mockReturnValue('callStatus');

			mockWebhookFunctions.getNodeParameter.mockImplementation((paramName: string) => {
				if (paramName === 'validateSignature') return true;
				if (paramName === 'events') return ['callStatus'];
				return undefined;
			});

			const bodyData = {
				CallUUID: 'call-123',
				From: '+14155551234',
				To: '+14155555678',
				CallStatus: 'completed',
				Direction: 'outbound',
				Duration: '45',
			};
			mockWebhookFunctions.getBodyData.mockReturnValue(bodyData);

			const result = await plivoTrigger.webhook!.call(mockWebhookFunctions);

			expect(result.workflowData).toBeDefined();
			expect(mockWebhookFunctions.helpers.returnJsonArray).toHaveBeenCalledWith({
				...bodyData,
				_eventType: 'callStatus',
			});
		});

		it('should handle multiple event subscriptions', async () => {
			(detectEventType as Mock).mockReturnValue('smsStatus');

			mockWebhookFunctions.getNodeParameter.mockImplementation((paramName: string) => {
				if (paramName === 'validateSignature') return true;
				if (paramName === 'events') return ['incomingSms', 'smsStatus', 'callStatus'];
				return undefined;
			});

			const bodyData = {
				MessageUUID: 'msg-123',
				Status: 'delivered',
			};
			mockWebhookFunctions.getBodyData.mockReturnValue(bodyData);

			const result = await plivoTrigger.webhook!.call(mockWebhookFunctions);

			expect(result.workflowData).toBeDefined();
		});

		it('should ignore unknown event types', async () => {
			(detectEventType as Mock).mockReturnValue('unknown');

			mockWebhookFunctions.getNodeParameter.mockImplementation((paramName: string) => {
				if (paramName === 'validateSignature') return true;
				if (paramName === 'events') return ['incomingSms', 'smsStatus'];
				return undefined;
			});

			mockWebhookFunctions.getBodyData.mockReturnValue({
				SomeUnknownField: 'value',
			});

			const result = await plivoTrigger.webhook!.call(mockWebhookFunctions);

			expect(result).toEqual({});
		});
	});

	describe('webhook method - real-world payloads', () => {
		beforeEach(() => {
			(verifyPlivoSignature as Mock).mockResolvedValue(true);
		});

		it('should handle complete Plivo incoming SMS payload', async () => {
			(detectEventType as Mock).mockReturnValue('incomingSms');

			mockWebhookFunctions.getNodeParameter.mockImplementation((paramName: string) => {
				if (paramName === 'validateSignature') return true;
				if (paramName === 'events') return ['incomingSms'];
				return undefined;
			});

			const bodyData = {
				From: '+14155551234',
				To: '+14155555678',
				Text: 'Test message content',
				Type: 'sms',
				MessageUUID: 'e8e1c9c0-5d5a-11e9-8647-d663bd873d93',
				TotalAmount: '0.0035',
				Units: '1',
				TotalRate: '0.0035',
				MCC: '310',
				MNC: '004',
				PowerpackUUID: '',
			};
			mockWebhookFunctions.getBodyData.mockReturnValue(bodyData);

			const result = await plivoTrigger.webhook!.call(mockWebhookFunctions);

			expect(result.workflowData).toBeDefined();
			expect(mockWebhookFunctions.helpers.returnJsonArray).toHaveBeenCalledWith({
				...bodyData,
				_eventType: 'incomingSms',
			});
		});

		it('should handle complete Plivo SMS delivery status payload', async () => {
			(detectEventType as Mock).mockReturnValue('smsStatus');

			mockWebhookFunctions.getNodeParameter.mockImplementation((paramName: string) => {
				if (paramName === 'validateSignature') return true;
				if (paramName === 'events') return ['smsStatus'];
				return undefined;
			});

			const bodyData = {
				From: '+14155551234',
				To: '+14155555678',
				Status: 'delivered',
				MessageUUID: 'e8e1c9c0-5d5a-11e9-8647-d663bd873d93',
				ParentMessageUUID: '',
				PartInfo: '1 of 1',
				TotalAmount: '0.0035',
				TotalRate: '0.0035',
				Units: '1',
				MCC: '310',
				MNC: '004',
				ErrorCode: '',
			};
			mockWebhookFunctions.getBodyData.mockReturnValue(bodyData);

			const result = await plivoTrigger.webhook!.call(mockWebhookFunctions);

			expect(result.workflowData).toBeDefined();
		});

		it('should handle complete Plivo incoming call payload', async () => {
			(detectEventType as Mock).mockReturnValue('incomingCall');

			mockWebhookFunctions.getNodeParameter.mockImplementation(
				(paramName: string, fallback?: unknown) => {
					if (paramName === 'validateSignature') return true;
					if (paramName === 'events') return ['incomingCall'];
					if (paramName === 'answerUrl') return 'https://example.com/answer';
					if (paramName === 'answerMethod') return 'POST';
					return fallback;
				},
			);

			const bodyData = {
				CallUUID: 'e8e1c9c0-5d5a-11e9-8647-d663bd873d93',
				From: '+14155551234',
				To: '+14155555678',
				CallStatus: 'ringing',
				Direction: 'inbound',
				ALegUUID: 'e8e1c9c0-5d5a-11e9-8647-d663bd873d93',
				ALegRequestUUID: 'e8e1c9c0-5d5a-11e9-8647-d663bd873d93',
			};
			mockWebhookFunctions.getBodyData.mockReturnValue(bodyData);

			const result = await plivoTrigger.webhook!.call(mockWebhookFunctions);

			expect(result.workflowData).toBeDefined();
		});

		it('should handle complete Plivo call status update payload', async () => {
			(detectEventType as Mock).mockReturnValue('callStatus');

			mockWebhookFunctions.getNodeParameter.mockImplementation((paramName: string) => {
				if (paramName === 'validateSignature') return true;
				if (paramName === 'events') return ['callStatus'];
				return undefined;
			});

			const bodyData = {
				CallUUID: 'e8e1c9c0-5d5a-11e9-8647-d663bd873d93',
				From: '+14155551234',
				To: '+14155555678',
				CallStatus: 'completed',
				Direction: 'outbound',
				Duration: '45',
				BillDuration: '60',
				BillRate: '0.0100',
				TotalCost: '0.0100',
				HangupCause: 'NORMAL_CLEARING',
				HangupSource: 'callee',
				EndTime: '2024-01-15 10:30:00',
				StartTime: '2024-01-15 10:29:15',
			};
			mockWebhookFunctions.getBodyData.mockReturnValue(bodyData);

			const result = await plivoTrigger.webhook!.call(mockWebhookFunctions);

			expect(result.workflowData).toBeDefined();
		});
	});
});

describe('PlivoTriggerHelpers - detectEventType', () => {
	// These tests verify the actual detectEventType function logic
	// We need to reimport without mocks for unit testing the helper
	let realDetectEventType: typeof detectEventType;
	beforeAll(async () => {
		({ detectEventType: realDetectEventType } =
			await vi.importActual<typeof import('./PlivoTriggerHelpers')>('./PlivoTriggerHelpers'));
	});

	it('should detect incoming SMS', () => {
		const payload = {
			MessageUUID: 'msg-uuid-123',
			From: '+14155551234',
			To: '+14155555678',
			Text: 'Hello, this is a test message',
			Type: 'sms',
		};
		expect(realDetectEventType(payload)).toBe('incomingSms');
	});

	it('should detect SMS delivery status', () => {
		const payload = {
			MessageUUID: 'msg-uuid-123',
			Status: 'delivered',
			From: '+14155551234',
			To: '+14155555678',
		};
		expect(realDetectEventType(payload)).toBe('smsStatus');
	});

	it('should detect incoming call', () => {
		const payload = {
			CallUUID: 'call-uuid-123',
			Direction: 'inbound',
			CallStatus: 'ringing',
			From: '+14155551234',
			To: '+14155555678',
		};
		expect(realDetectEventType(payload)).toBe('incomingCall');
	});

	it('should detect call status update for outbound completed call', () => {
		const payload = {
			CallUUID: 'call-uuid-123',
			Direction: 'outbound',
			CallStatus: 'completed',
			Duration: 120,
		};
		expect(realDetectEventType(payload)).toBe('callStatus');
	});

	it('should detect call status for answered inbound call', () => {
		const payload = {
			CallUUID: 'call-uuid-123',
			Direction: 'inbound',
			CallStatus: 'answered',
		};
		expect(realDetectEventType(payload)).toBe('callStatus');
	});

	it('should return unknown for unrecognized payload', () => {
		const payload = {
			SomeOtherField: 'value',
		};
		expect(realDetectEventType(payload)).toBe('unknown');
	});

	it('should return unknown for empty payload', () => {
		expect(realDetectEventType({})).toBe('unknown');
	});

	it('should handle MessageUUID without Text or Status', () => {
		const payload = {
			MessageUUID: 'msg-uuid-123',
			From: '+14155551234',
		};
		expect(realDetectEventType(payload)).toBe('unknown');
	});

	it('should handle CallUUID without CallStatus', () => {
		const payload = {
			CallUUID: 'call-uuid-123',
			Direction: 'inbound',
		};
		expect(realDetectEventType(payload)).toBe('unknown');
	});

	it('should prioritize Status over Text when both present (SMS status)', () => {
		const payload = {
			MessageUUID: 'msg-uuid-123',
			Status: 'delivered',
			Text: 'Some text',
		};
		expect(realDetectEventType(payload)).toBe('smsStatus');
	});
});

describe('PlivoTriggerHelpers - verifyPlivoSignature', () => {
	// Import actual implementation for signature verification tests
	let realVerifyPlivoSignature: typeof verifyPlivoSignature;
	beforeAll(async () => {
		({ verifyPlivoSignature: realVerifyPlivoSignature } =
			await vi.importActual<typeof import('./PlivoTriggerHelpers')>('./PlivoTriggerHelpers'));
	});

	// Helper to compute the expected signature using Plivo's V3 base string:
	// URL, then (for POST) the params in key-sorted order as key+value, then the nonce.
	function computeExpectedSignature(
		authToken: string,
		webhookUrl: string,
		nonce: string,
		params?: Record<string, string>,
	): string {
		let baseString = webhookUrl;
		if (params) {
			baseString += Object.keys(params)
				.sort()
				.map((key) => `${key}${params[key]}`)
				.join('');
		}
		baseString += nonce;
		const hmac = createHmac('sha256', authToken);
		hmac.update(baseString);
		return hmac.digest('base64');
	}

	function createMockWebhookFunctions(options: {
		authToken?: string;
		signature?: string;
		nonce?: string;
		webhookUrl?: string;
		method?: string;
		params?: Record<string, string>;
	}) {
		const {
			authToken = 'test-auth-token',
			signature,
			nonce,
			webhookUrl = 'https://example.com/webhook/plivo',
			method = 'POST',
			params,
		} = options;

		return {
			getCredentials: vi.fn().mockResolvedValue({
				authId: 'test-auth-id',
				authToken,
			}),
			getRequestObject: vi.fn().mockReturnValue({
				headers: {
					'x-plivo-signature-v3': signature,
					'x-plivo-signature-v3-nonce': nonce,
				},
				method,
			}),
			getBodyData: vi.fn().mockReturnValue(params ?? {}),
			getNodeWebhookUrl: vi.fn().mockReturnValue(webhookUrl),
		};
	}

	it('should return true when no auth token is configured', async () => {
		const mockFunctions = createMockWebhookFunctions({
			authToken: '',
		});

		const result = await realVerifyPlivoSignature.call(mockFunctions);
		expect(result).toBe(true);
	});

	it('should return false when signature header is missing', async () => {
		const mockFunctions = createMockWebhookFunctions({
			authToken: 'test-token',
			nonce: '12345678',
			// signature is undefined
		});

		const result = await realVerifyPlivoSignature.call(mockFunctions);
		expect(result).toBe(false);
	});

	it('should return false when nonce header is missing', async () => {
		const mockFunctions = createMockWebhookFunctions({
			authToken: 'test-token',
			signature: 'some-signature',
			// nonce is undefined
		});

		const result = await realVerifyPlivoSignature.call(mockFunctions);
		expect(result).toBe(false);
	});

	it('should validate correct signature for GET request', async () => {
		const authToken = 'test-auth-token-12345';
		const webhookUrl = 'https://example.com/webhook/plivo';
		const nonce = '12345678';
		const expectedSignature = computeExpectedSignature(authToken, webhookUrl, nonce);

		const mockFunctions = createMockWebhookFunctions({
			authToken,
			webhookUrl,
			nonce,
			signature: expectedSignature,
			method: 'GET',
		});

		const result = await realVerifyPlivoSignature.call(mockFunctions);
		expect(result).toBe(true);
	});

	it('should validate correct signature for POST request with params', async () => {
		const authToken = 'test-auth-token-12345';
		const webhookUrl = 'https://example.com/webhook/plivo';
		const nonce = '12345678';
		const params = { From: '+14155551234', To: '+14155555678', Text: 'Hello' };
		const expectedSignature = computeExpectedSignature(authToken, webhookUrl, nonce, params);

		const mockFunctions = createMockWebhookFunctions({
			authToken,
			webhookUrl,
			nonce,
			signature: expectedSignature,
			method: 'POST',
			params,
		});

		const result = await realVerifyPlivoSignature.call(mockFunctions);
		expect(result).toBe(true);
	});

	it('should validate regardless of POST parameter order', async () => {
		const authToken = 'test-auth-token-12345';
		const webhookUrl = 'https://example.com/webhook/plivo';
		const nonce = '12345678';
		// Signature computed from one order; request delivers a different order.
		const expectedSignature = computeExpectedSignature(authToken, webhookUrl, nonce, {
			From: '+14155551234',
			To: '+14155555678',
			Text: 'Hello',
		});

		const mockFunctions = createMockWebhookFunctions({
			authToken,
			webhookUrl,
			nonce,
			signature: expectedSignature,
			method: 'POST',
			params: { Text: 'Hello', To: '+14155555678', From: '+14155551234' },
		});

		const result = await realVerifyPlivoSignature.call(mockFunctions);
		expect(result).toBe(true);
	});

	it('should accept a matching signature among comma-separated signatures', async () => {
		const authToken = 'test-auth-token-12345';
		const webhookUrl = 'https://example.com/webhook/plivo';
		const nonce = '12345678';
		const params = { From: '+14155551234', Text: 'Hello' };
		const valid = computeExpectedSignature(authToken, webhookUrl, nonce, params);

		const mockFunctions = createMockWebhookFunctions({
			authToken,
			webhookUrl,
			nonce,
			signature: `some-other-signature,${valid}`,
			method: 'POST',
			params,
		});

		const result = await realVerifyPlivoSignature.call(mockFunctions);
		expect(result).toBe(true);
	});

	it('should reject incorrect signature', async () => {
		const authToken = 'test-auth-token-12345';
		const webhookUrl = 'https://example.com/webhook/plivo';
		const nonce = '12345678';

		const mockFunctions = createMockWebhookFunctions({
			authToken,
			webhookUrl,
			nonce,
			signature: 'invalid-signature-that-wont-match',
			method: 'GET',
		});

		const result = await realVerifyPlivoSignature.call(mockFunctions);
		expect(result).toBe(false);
	});

	it('should reject signature with wrong auth token', async () => {
		const authToken = 'correct-auth-token';
		const wrongToken = 'wrong-auth-token';
		const webhookUrl = 'https://example.com/webhook/plivo';
		const nonce = '12345678';
		// Compute signature with wrong token
		const wrongSignature = computeExpectedSignature(wrongToken, webhookUrl, nonce);

		const mockFunctions = createMockWebhookFunctions({
			authToken, // Server has correct token
			webhookUrl,
			nonce,
			signature: wrongSignature, // But signature was made with wrong token
			method: 'GET',
		});

		const result = await realVerifyPlivoSignature.call(mockFunctions);
		expect(result).toBe(false);
	});

	it('should reject signature with tampered body', async () => {
		const authToken = 'test-auth-token-12345';
		const webhookUrl = 'https://example.com/webhook/plivo';
		const nonce = '12345678';
		const originalParams = { From: '+14155551234', Text: 'Original' };
		const tamperedParams = { From: '+14155551234', Text: 'Tampered' };
		// Signature computed with original params
		const signature = computeExpectedSignature(authToken, webhookUrl, nonce, originalParams);

		const mockFunctions = createMockWebhookFunctions({
			authToken,
			webhookUrl,
			nonce,
			signature,
			method: 'POST',
			params: tamperedParams, // But request delivers tampered params
		});

		const result = await realVerifyPlivoSignature.call(mockFunctions);
		expect(result).toBe(false);
	});

	it('should produce different signatures for different URLs', () => {
		const authToken = 'test-token';
		const nonce = '12345678';
		const sig1 = computeExpectedSignature(authToken, 'https://example.com/webhook1', nonce);
		const sig2 = computeExpectedSignature(authToken, 'https://example.com/webhook2', nonce);
		expect(sig1).not.toBe(sig2);
	});

	it('should produce different signatures for different nonces', () => {
		const authToken = 'test-token';
		const webhookUrl = 'https://example.com/webhook';
		const sig1 = computeExpectedSignature(authToken, webhookUrl, 'nonce1');
		const sig2 = computeExpectedSignature(authToken, webhookUrl, 'nonce2');
		expect(sig1).not.toBe(sig2);
	});

	it('should produce base64 encoded signatures', () => {
		const authToken = 'test-token';
		const webhookUrl = 'https://example.com/webhook';
		const nonce = '12345678';
		const signature = computeExpectedSignature(authToken, webhookUrl, nonce);
		// Verify it's valid base64 by decoding and re-encoding
		expect(Buffer.from(signature, 'base64').toString('base64')).toBe(signature);
	});
});

describe('PlivoTrigger Node - webhookMethods', () => {
	const WEBHOOK = 'https://n8n.example.com/webhook/abc';
	let plivoTrigger: PlivoTrigger;
	let mockHookFunctions: ReturnType<typeof mock<IHookFunctions>>;
	let staticData: IDataObject;

	beforeEach(() => {
		vi.clearAllMocks();
		plivoTrigger = new PlivoTrigger();
		mockHookFunctions = mock<IHookFunctions>();
		staticData = {};
		mockHookFunctions.getWorkflowStaticData.mockReturnValue(staticData);
		mockHookFunctions.getNodeWebhookUrl.mockReturnValue(WEBHOOK);
		// Default to a production activation; individual tests override to 'manual'.
		mockHookFunctions.getActivationMode.mockReturnValue('activate');
	});

	function setParams(events: string[], phoneNumbers: string[] = []) {
		mockHookFunctions.getNodeParameter.mockImplementation((name: string) => {
			if (name === 'events') return events;
			if (name === 'phoneNumbers') return phoneNumbers;
			return undefined;
		});
	}

	describe('checkExists', () => {
		it('returns false when nothing is registered', async () => {
			const result = await plivoTrigger.webhookMethods.default.checkExists.call(mockHookFunctions);
			expect(result).toBe(false);
		});

		it('returns true when managed apps are stored', async () => {
			staticData.managedApps = { '+14155550123': { appId: 'APP-1' } };
			const result = await plivoTrigger.webhookMethods.default.checkExists.call(mockHookFunctions);
			expect(result).toBe(true);
		});

		it('tracks test registrations under a separate key', async () => {
			// A production registration must not make a test registration look present.
			staticData.managedApps = { '+14155550123': { appId: 'APP-1' } };
			mockHookFunctions.getActivationMode.mockReturnValue('manual');
			const result = await plivoTrigger.webhookMethods.default.checkExists.call(mockHookFunctions);
			expect(result).toBe(false);
		});
	});

	describe('create', () => {
		it('does nothing when only SMS delivery status is selected', async () => {
			setParams(['smsStatus'], ['+14155550123']);

			const result = await plivoTrigger.webhookMethods.default.create.call(mockHookFunctions);

			expect(result).toBe(true);
			expect(plivoApiRequest).not.toHaveBeenCalled();
			expect(staticData.managedApps).toBeUndefined();
		});

		it('creates a per-number app, links the number, and sets the message URL for incoming SMS', async () => {
			setParams(['incomingSms'], ['+14155550123']);
			(plivoApiRequest as Mock).mockImplementation(
				async (method: string, endpoint: string) => {
					if (method === 'GET' && endpoint === '/Number/14155550123') return { application: '' };
					if (method === 'POST' && endpoint === '/Application') return { app_id: 'APP-NEW' };
					return {};
				},
			);

			await plivoTrigger.webhookMethods.default.create.call(mockHookFunctions);

			expect(plivoApiRequest).toHaveBeenCalledWith('POST', '/Application', {
				app_name: 'n8n-plivo-trigger-14155550123',
			});
			expect(plivoApiRequest).toHaveBeenCalledWith('POST', '/Number/14155550123', {
				app_id: 'APP-NEW',
			});
			expect(plivoApiRequest).toHaveBeenCalledWith(
				'POST',
				'/Application/APP-NEW',
				expect.objectContaining({ message_url: WEBHOOK, message_method: 'POST' }),
			);
			expect(
				((staticData.managedApps as IDataObject)['+14155550123'] as IDataObject).appId,
			).toBe('APP-NEW');
		});

		it('reuses the number existing n8n app and adds the answer URL so voice and SMS coexist', async () => {
			setParams(['incomingCall'], ['+14155550123']);
			(plivoApiRequest as Mock).mockImplementation(
				async (method: string, endpoint: string) => {
					if (method === 'GET' && endpoint === '/Number/14155550123') {
						return { application: '/v1/Account/X/Application/APP-EXIST/' };
					}
					if (method === 'GET' && endpoint === '/Application/APP-EXIST') {
						return { app_name: 'n8n-plivo-trigger-14155550123', message_url: WEBHOOK };
					}
					return {};
				},
			);

			await plivoTrigger.webhookMethods.default.create.call(mockHookFunctions);

			expect(plivoApiRequest).not.toHaveBeenCalledWith('POST', '/Application', expect.anything());
			expect(plivoApiRequest).toHaveBeenCalledWith(
				'POST',
				'/Application/APP-EXIST',
				expect.objectContaining({ answer_url: WEBHOOK, answer_method: 'POST' }),
			);
			expect(
				((staticData.managedApps as IDataObject)['+14155550123'] as IDataObject).appId,
			).toBe('APP-EXIST');
		});

		it('refuses to publish when the number is already managed by another workflow', async () => {
			setParams(['incomingCall'], ['+14155550123']);
			(plivoApiRequest as Mock).mockImplementation(
				async (method: string, endpoint: string) => {
					if (method === 'GET' && endpoint === '/Number/14155550123') {
						return { application: '/v1/Account/X/Application/APP-EXIST/' };
					}
					if (method === 'GET' && endpoint === '/Application/APP-EXIST') {
						// answer_url points at a different node's webhook id than WEBHOOK ('/webhook/abc').
						return {
							app_name: 'n8n-plivo-trigger-14155550123',
							answer_url: 'https://n8n.example.com/webhook/other-node/webhook',
						};
					}
					return {};
				},
			);

			await expect(
				plivoTrigger.webhookMethods.default.create.call(mockHookFunctions),
			).rejects.toThrow(/already receiving incoming calls in another active workflow/);
			expect(plivoApiRequest).not.toHaveBeenCalledWith('DELETE', expect.anything());
		});
	});

	describe('delete', () => {
		it('clears the URLs, deletes an app it created, and restores the previous app', async () => {
			staticData.managedApps = {
				'+14155550123': { appId: 'APP-1', createdApp: true, previousAppId: 'APP-OLD', snapshot: {} },
			};

			await plivoTrigger.webhookMethods.default.delete.call(mockHookFunctions);

			expect(plivoApiRequest).toHaveBeenCalledWith('POST', '/Application/APP-1', {
				answer_url: '',
				message_url: '',
			});
			expect(plivoApiRequest).toHaveBeenCalledWith('POST', '/Number/14155550123', {
				app_id: 'APP-OLD',
			});
			expect(plivoApiRequest).toHaveBeenCalledWith('DELETE', '/Application/APP-1');
			expect(staticData.managedApps).toBeUndefined();
		});

		it('does not delete an app it did not create', async () => {
			staticData.managedApps = {
				'+14155550123': { appId: 'APP-1', createdApp: false, previousAppId: '', snapshot: {} },
			};

			await plivoTrigger.webhookMethods.default.delete.call(mockHookFunctions);

			expect(plivoApiRequest).toHaveBeenCalledWith('POST', '/Application/APP-1', {
				answer_url: '',
				message_url: '',
			});
			expect(plivoApiRequest).not.toHaveBeenCalledWith('DELETE', expect.anything());
		});
	});

	describe('test registration is non-destructive to production', () => {
		it('snapshots the production URLs on a test create and restores them on test delete', async () => {
			mockHookFunctions.getActivationMode.mockReturnValue('manual');
			setParams(['incomingCall'], ['+14155550123']);
			const TEST_URL = 'https://n8n.example.com/webhook-test/abc';
			const PROD_URL = 'https://n8n.example.com/webhook/abc';
			mockHookFunctions.getNodeWebhookUrl.mockReturnValue(TEST_URL);
			(plivoApiRequest as Mock).mockImplementation(
				async (method: string, endpoint: string) => {
					if (method === 'GET' && endpoint === '/Number/14155550123') {
						return { application: '/v1/Account/X/Application/APP-PROD/' };
					}
					if (method === 'GET' && endpoint === '/Application/APP-PROD') {
						return {
							app_name: 'n8n-plivo-trigger-14155550123',
							answer_url: PROD_URL,
							answer_method: 'POST',
						};
					}
					return {};
				},
			);

			// Test create points the number at the test URL and records under its own key.
			await plivoTrigger.webhookMethods.default.create.call(mockHookFunctions);
			expect(plivoApiRequest).toHaveBeenCalledWith(
				'POST',
				'/Application/APP-PROD',
				expect.objectContaining({ answer_url: TEST_URL }),
			);
			expect(staticData.managedApps).toBeUndefined();
			const entry = (staticData.testManagedApps as IDataObject)['+14155550123'] as IDataObject;
			expect(entry.appId).toBe('APP-PROD');
			expect(entry.createdApp).toBe(false);
			expect((entry.snapshot as IDataObject).answer_url).toBe(PROD_URL);

			(plivoApiRequest as Mock).mockClear();

			// Test delete restores the production URL and never deletes or reassigns.
			await plivoTrigger.webhookMethods.default.delete.call(mockHookFunctions);
			expect(plivoApiRequest).toHaveBeenCalledWith(
				'POST',
				'/Application/APP-PROD',
				expect.objectContaining({ answer_url: PROD_URL }),
			);
			expect(plivoApiRequest).not.toHaveBeenCalledWith('DELETE', expect.anything());
			expect(staticData.testManagedApps).toBeUndefined();
		});
	});
});
