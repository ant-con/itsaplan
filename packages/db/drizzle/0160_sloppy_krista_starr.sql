ALTER TABLE "runner_plan_child" ADD COLUMN "claim_parent_run_id" integer;--> statement-breakpoint
ALTER TABLE "runner_plan_child" ADD COLUMN "claim_parent_attempt" integer;--> statement-breakpoint
ALTER TABLE "runner_plan_child" ADD COLUMN "claim_child_attempt" integer;--> statement-breakpoint
CREATE INDEX "runner_plan_child_child_run_idx" ON "runner_plan_child" USING btree ("child_run_id");