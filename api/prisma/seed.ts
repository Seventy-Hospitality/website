import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import Stripe from 'stripe';
import { createId } from '@paralleldrive/cuid2';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(import.meta.dirname, '../.env') });

const stripeKey = process.env.STRIPE_SECRET_KEY;
const useStripe = stripeKey && !stripeKey.includes('REPLACE_ME') && !stripeKey.includes('placeholder');
const stripe = useStripe ? new Stripe(stripeKey) : null;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const DEFAULT_EVENT_TIMEZONE = 'America/New_York';

function daysFromNowAt(daysFromNow: number, hours: number, minutes = 0) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function nextWeekdayAt(weekday: number, hours: number, minutes = 0) {
  const date = new Date();
  const delta = (weekday - date.getDay() + 7) % 7 || 7;
  date.setDate(date.getDate() + delta);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

async function main() {
  console.log('Seeding Seventy database...\n');

  // ── Membership Plans ──
  // Replace with actual Stripe test IDs from your dashboard
  const monthlyPlan = await prisma.membershipPlan.upsert({
    where: { stripePriceId: process.env.SEED_MONTHLY_PRICE_ID ?? 'price_monthly_placeholder' },
    update: {},
    create: {
      name: 'Monthly Membership',
      stripePriceId: process.env.SEED_MONTHLY_PRICE_ID ?? 'price_monthly_placeholder',
      stripeProductId: process.env.SEED_MONTHLY_PRODUCT_ID ?? 'prod_monthly_placeholder',
      amountCents: 5000,
      interval: 'month',
      active: true,
    },
  });

  const annualPlan = await prisma.membershipPlan.upsert({
    where: { stripePriceId: process.env.SEED_ANNUAL_PRICE_ID ?? 'price_annual_placeholder' },
    update: {},
    create: {
      name: 'Annual Membership',
      stripePriceId: process.env.SEED_ANNUAL_PRICE_ID ?? 'price_annual_placeholder',
      stripeProductId: process.env.SEED_ANNUAL_PRODUCT_ID ?? 'prod_annual_placeholder',
      amountCents: 48000,
      interval: 'year',
      active: true,
    },
  });

  console.log(`  Plans: ${monthlyPlan.name}, ${annualPlan.name}`);

  // ── Sample Members ──
  const members = [
    { firstName: 'Alice', lastName: 'Chen', email: 'alice@example.com', phone: '555-0101' },
    { firstName: 'Bob', lastName: 'Park', email: 'bob@example.com', phone: '555-0102' },
    { firstName: 'Carol', lastName: 'Nguyen', email: 'carol@example.com', phone: null },
    { firstName: 'Dave', lastName: 'Singh', email: 'dave@example.com', phone: '555-0104' },
    { firstName: 'Eve', lastName: 'Tanaka', email: 'eve@example.com', phone: null },
    { firstName: 'Frank', lastName: 'Williams', email: 'frank@example.com', phone: '555-0106' },
    { firstName: 'Grace', lastName: 'Kim', email: 'grace@example.com', phone: null },
    { firstName: 'Hank', lastName: 'Patel', email: 'hank@example.com', phone: '555-0108' },
    { firstName: 'Iris', lastName: 'Lopez', email: 'iris@example.com', phone: '555-0109' },
    { firstName: 'Jack', lastName: 'Brown', email: 'jack@example.com', phone: null },
  ];

  const created = [];
  for (const m of members) {
    let stripeCustomerId: string | null = null;

    if (stripe) {
      const existing = await stripe.customers.list({ email: m.email, limit: 1 });
      if (existing.data.length > 0) {
        stripeCustomerId = existing.data[0].id;
      } else {
        const customer = await stripe.customers.create({
          email: m.email,
          name: `${m.firstName} ${m.lastName}`,
          metadata: { source: 'seventy-seed' },
        });
        stripeCustomerId = customer.id;
      }
    }

    const member = await prisma.member.upsert({
      where: { email: m.email },
      update: { stripeCustomerId: stripeCustomerId ?? undefined },
      create: { ...m, stripeCustomerId },
    });
    created.push(member);
  }

  console.log(`  Members: ${created.length}${stripe ? ' (with Stripe customers)' : ''}`);

  // ── Memberships (local projection — no Stripe in seed) ──
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const nextYear = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
  const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const subs = [
    { member: created[0], plan: monthlyPlan, status: 'active', periodEnd: nextMonth, cancel: false },
    { member: created[1], plan: monthlyPlan, status: 'active', periodEnd: nextMonth, cancel: false },
    { member: created[2], plan: monthlyPlan, status: 'active', periodEnd: nextMonth, cancel: false },
    { member: created[3], plan: annualPlan, status: 'active', periodEnd: nextYear, cancel: false },
    { member: created[4], plan: monthlyPlan, status: 'past_due', periodEnd: lastWeek, cancel: false },
    { member: created[5], plan: monthlyPlan, status: 'active', periodEnd: nextMonth, cancel: true },
    { member: created[6], plan: annualPlan, status: 'canceled', periodEnd: lastWeek, cancel: false },
  ];

  for (const s of subs) {
    let stripeSubId = `sub_dev_${createId()}`;

    if (stripe && s.member.stripeCustomerId && s.status === 'active') {
      // Check for existing subscription before creating
      const existingSubs = await stripe.subscriptions.list({
        customer: s.member.stripeCustomerId,
        limit: 1,
      });

      if (existingSubs.data.length > 0) {
        stripeSubId = existingSubs.data[0].id;
      } else {
        const sub = await stripe.subscriptions.create({
          customer: s.member.stripeCustomerId,
          items: [{ price: s.plan.stripePriceId }],
          payment_behavior: 'default_incomplete',
          metadata: { memberId: s.member.id, source: 'seventy-seed' },
        });
        stripeSubId = sub.id;
      }
    }

    await prisma.membership.upsert({
      where: { memberId: s.member.id },
      update: {},
      create: {
        memberId: s.member.id,
        planId: s.plan.id,
        stripeSubscriptionId: stripeSubId,
        status: s.status,
        currentPeriodEnd: s.periodEnd,
        cancelAtPeriodEnd: s.cancel,
      },
    });
  }

  console.log(`  Memberships: 3 active, 1 annual, 1 past_due, 1 canceling, 1 canceled, 3 none${stripe ? ' (active ones synced to Stripe)' : ''}`);

  // ── Admin Notes ──
  const adminUser = await prisma.user.findFirst({ where: { staffRole: 'admin' } });

  if (adminUser) {
    const notes = [
      { member: created[0], content: 'Founding member. Plays doubles on Tuesday evenings.' },
      { member: created[0], content: 'Updated phone number per request.' },
      { member: created[4], content: 'Payment failed — reached out via email, waiting for response.' },
      { member: created[5], content: 'Requested cancellation — moving out of area.' },
      { member: created[6], content: 'May return next season.' },
    ];

    await prisma.adminNote.deleteMany({
      where: { authorId: adminUser.id },
    });

    for (const n of notes) {
      await prisma.adminNote.create({
        data: { memberId: n.member.id, authorId: adminUser.id, content: n.content },
      });
    }

    console.log(`  Notes: ${notes.length}`);
  } else {
    console.log('  Notes: skipped (no admin user)');
  }

  // ── Courts ──
  const courts = [
    { name: 'Court 1' },
    { name: 'Court 2' },
    { name: 'Court 3' },
  ];

  for (const c of courts) {
    await prisma.court.upsert({
      where: { id: c.name.toLowerCase().replace(' ', '-') },
      update: {},
      create: { id: c.name.toLowerCase().replace(' ', '-'), ...c },
    });
  }

  console.log(`  Courts: ${courts.length}`);

  // ── Showers ──
  const showers = [
    { name: 'Shower A' },
    { name: 'Shower B' },
  ];

  for (const s of showers) {
    await prisma.shower.upsert({
      where: { id: s.name.toLowerCase().replace(' ', '-') },
      update: {},
      create: { id: s.name.toLowerCase().replace(' ', '-'), ...s },
    });
  }

  console.log(`  Showers: ${showers.length}`);

  // ── Club Events ──
  const clubEvents = [
    {
      id: 'seed-sunday-open-play',
      title: 'Sunday Open Play',
      imageUrl: 'https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?w=800&h=400&fit=crop',
      details: 'All-level social play. Courts 1 and 2 are reserved for drop-in ladders, doubles rotations, and member guests.',
      startsAt: nextWeekdayAt(0, 10),
      endsAt: nextWeekdayAt(0, 20),
      timezone: DEFAULT_EVENT_TIMEZONE,
      active: true,
      courtIds: ['court-1', 'court-2'],
    },
    {
      id: 'seed-skills-clinic',
      title: 'Serve + Return Clinic',
      imageUrl: 'https://images.unsplash.com/photo-1613918431703-aa50889e3be2?w=800&h=400&fit=crop',
      details: 'Small-group coaching focused on first-ball patterns. Court 3 is blocked for instruction and feed drills.',
      startsAt: nextWeekdayAt(3, 18),
      endsAt: nextWeekdayAt(3, 20),
      timezone: DEFAULT_EVENT_TIMEZONE,
      active: true,
      courtIds: ['court-3'],
    },
    {
      id: 'seed-member-social',
      title: 'Member Social Hour',
      imageUrl: 'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?w=800&h=400&fit=crop',
      details: 'Low-key social in the lounge with no court claim, useful for testing events that should not affect bookings.',
      startsAt: nextWeekdayAt(5, 19),
      endsAt: nextWeekdayAt(5, 22),
      timezone: DEFAULT_EVENT_TIMEZONE,
      active: true,
      courtIds: [],
    },
    {
      id: 'seed-ladder-finals',
      title: 'Winter Ladder Finals',
      imageUrl: 'https://images.unsplash.com/photo-1554068865-24cecd4e34b8?w=800&h=400&fit=crop',
      details: 'Completed event left in the system so the admin UI can exercise past-event states and editing.',
      startsAt: daysFromNowAt(-7, 17),
      endsAt: daysFromNowAt(-7, 21),
      timezone: DEFAULT_EVENT_TIMEZONE,
      active: false,
      courtIds: ['court-1'],
    },
  ];

  for (const event of clubEvents) {
    const { id, courtIds, ...eventData } = event;
    await prisma.clubEvent.upsert({
      where: { id },
      update: {
        ...eventData,
        courts: {
          deleteMany: {},
          ...(courtIds.length > 0
            ? { create: courtIds.map((courtId) => ({ courtId })) }
            : {}),
        },
      },
      create: {
        id,
        ...eventData,
        courts: courtIds.length > 0
          ? { create: courtIds.map((courtId) => ({ courtId })) }
          : undefined,
      },
    });
  }

  console.log(`  Events: ${clubEvents.length}`);

  console.log('\nDone.');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
