import { prepareEarnings } from "@/lib/api/earnings/prepare-earnings";
import { includeTags } from "@/lib/api/links/include-tags";
import { notifyPartnerSale } from "@/lib/api/partners/notify-partner-sale";
import { getLeadEvent, recordSale } from "@/lib/tinybird";
import { redis } from "@/lib/upstash";
import { sendWorkspaceWebhook } from "@/lib/webhook/publish";
import { transformSaleEventData } from "@/lib/webhook/transform";
import { prisma } from "@dub/prisma";
import { nanoid } from "@dub/utils";
import { waitUntil } from "@vercel/functions";
import type Stripe from "stripe";

// Handle event "invoice.paid"
export async function invoicePaid(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const stripeCustomerId = invoice.customer as string;
  const invoiceId = invoice.id;

  // Find customer using projectConnectId and stripeCustomerId
  const customer = await prisma.customer.findUnique({
    where: {
      stripeCustomerId,
    },
  });

  if (!customer) {
    return `Customer with stripeCustomerId ${stripeCustomerId} not found, skipping...`;
  }

  // Skip if invoice id is already processed
  const ok = await redis.set(`dub_sale_events:invoiceId:${invoiceId}`, 1, {
    ex: 60 * 60 * 24 * 7,
    nx: true,
  });

  if (!ok) {
    console.info(
      "[Stripe Webhook] Skipping already processed invoice.",
      invoiceId,
    );
    return `Invoice with ID ${invoiceId} already processed, skipping...`;
  }

  if (invoice.amount_paid === 0) {
    return `Invoice with ID ${invoiceId} has an amount of 0, skipping...`;
  }

  // Find lead
  const leadEvent = await getLeadEvent({ customerId: customer.id });
  if (!leadEvent || leadEvent.data.length === 0) {
    return `Lead event with customer ID ${customer.id} not found, skipping...`;
  }

  const eventId = nanoid(16);

  const saleData = {
    ...leadEvent.data[0],
    event_id: eventId,
    event_name: "Subscription update",
    payment_processor: "stripe",
    amount: invoice.amount_paid,
    currency: invoice.currency,
    invoice_id: invoiceId,
    metadata: JSON.stringify({
      invoice,
    }),
  };

  const linkId = leadEvent.data[0].link_id;
  const link = await prisma.link.findUnique({
    where: {
      id: linkId,
    },
  });

  if (!link) {
    return `Link with ID ${linkId} not found, skipping...`;
  }

  const [_sale, linkUpdated, workspace] = await Promise.all([
    recordSale(saleData),

    // update link sales count
    prisma.link.update({
      where: {
        id: linkId,
      },
      data: {
        sales: {
          increment: 1,
        },
        saleAmount: {
          increment: invoice.amount_paid,
        },
      },
      include: includeTags,
    }),
    // update workspace sales usage
    prisma.project.update({
      where: {
        id: customer.projectId,
      },
      data: {
        usage: {
          increment: 1,
        },
        salesUsage: {
          increment: invoice.amount_paid,
        },
      },
    }),
  ]);

  // for program links
  if (link.programId) {
    const { program, ...partner } =
      await prisma.programEnrollment.findFirstOrThrow({
        where: {
          links: {
            some: {
              id: link.id,
            },
          },
        },
        select: {
          program: true,
          partnerId: true,
          commissionAmount: true,
        },
      });

    const earningsData = prepareEarnings({
      linkId: link.id,
      customerId: customer.id,
      program,
      partner,
      event: {
        type: "sale",
        id: eventId,
      },
      sale: {
        amount: saleData.amount,
        currency: saleData.currency,
        invoiceId: saleData.invoice_id,
      },
    });

    await prisma.earnings.create({
      data: earningsData,
    });

    waitUntil(
      notifyPartnerSale({
        partner: {
          id: partner.partnerId,
          referralLink: link.shortLink,
        },
        program,
        sale: {
          amount: earningsData.amount!,
          earnings: earningsData.earnings!,
        },
      }),
    );
  }

  // send workspace webhook
  waitUntil(
    sendWorkspaceWebhook({
      trigger: "sale.created",
      workspace,
      data: transformSaleEventData({
        ...saleData,
        clickedAt: customer.clickedAt || customer.createdAt,
        link: linkUpdated,
        customer,
      }),
    }),
  );

  return `Sale recorded for customer ID ${customer.id} and invoice ID ${invoiceId}`;
}
