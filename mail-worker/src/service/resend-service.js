import emailService from './email-service';
import { emailConst } from '../const/entity-const';

const resendService = {
	async webhooks(c, body) {
		const params = {
			resendEmailId: body.data.email_id,
			status: emailConst.status.SENT,
		};

		if (body.type === 'email.delivered') {
			params.status = emailConst.status.DELIVERED;
			params.message = null;
		}

		if (body.type === 'email.complained') {
			params.status = emailConst.status.COMPLAINED;
			params.message = null;
		}

		if (body.type === 'email.bounced') {
			let bounce = body.data.bounce;
			bounce = JSON.stringify(bounce);
			params.status = emailConst.status.BOUNCED;
			params.message = bounce;
		}

		if (body.type === 'email.delivery_delayed') {
			params.status = emailConst.status.DELAYED;
			params.message = null;
		}

		if (body.type === 'email.failed') {
			params.status = emailConst.status.FAILED;
			params.message = body.data.failed.reason;
		}

		const emailRow = await emailService.updateEmailStatus(c, params);

		// No matching row means this Resend event belongs to an email that
		// wasn't sent through this cloud-mail instance's own database (the
		// same Resend account/domain is also used for other direct sends,
		// e.g. transactional email from the site's own backend). That is
		// the expected, normal case — not a failure — so it must not throw.
		// Previously this threw BizError here, which the route handler
		// (resend-api.js) turns into an HTTP 500, causing Resend to flag
		// the webhook as failing and eventually auto-disable it. A real
		// database error still throws naturally from updateEmailStatus()
		// above and is unaffected by this change.
		if (!emailRow) {
			return;
		}
	},
};

export default resendService;
