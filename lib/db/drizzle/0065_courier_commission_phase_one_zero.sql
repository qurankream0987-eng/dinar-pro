-- Owner decision (phase one): the independent-driver platform commission is 0 %. The fare stays
-- agreed between the driver and the customer. New agreements snapshot rate 0; agreements and
-- receivables created under the earlier 10 % rule are kept unchanged (no historical rewrite).
ALTER TABLE "courier_fare_agreements" DROP CONSTRAINT "courier_fare_agreements_rate_fixed";--> statement-breakpoint
ALTER TABLE "courier_fare_agreements" ADD CONSTRAINT "courier_fare_agreements_rate_known" CHECK ("courier_fare_agreements"."commission_rate_bps" IN (0, 1000));--> statement-breakpoint
ALTER TABLE "courier_fare_agreements" ADD CONSTRAINT "courier_fare_agreements_zero_rate_zero_estimate" CHECK ("courier_fare_agreements"."commission_rate_bps" <> 0 OR "courier_fare_agreements"."commission_estimate_minor" = 0);
