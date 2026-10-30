CREATE TABLE "runner_plan_child" (
	"parent_issue_id" integer NOT NULL,
	"operation_id" text NOT NULL,
	"parent_run_id" integer,
	"agent_id" integer,
	"input_hash" text NOT NULL,
	"budget_seconds" integer NOT NULL,
	"child_issue_id" integer,
	"child_run_id" integer,
	CONSTRAINT "runner_plan_child_parent_issue_id_operation_id_pk" PRIMARY KEY("parent_issue_id","operation_id"),
	CONSTRAINT "runner_plan_child_budget_check" CHECK ("runner_plan_child"."budget_seconds" BETWEEN 1 AND 600)
);
--> statement-breakpoint
ALTER TABLE "runner_plan_child" ADD CONSTRAINT "runner_plan_child_parent_issue_id_issue_id_fk" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_plan_child" ADD CONSTRAINT "runner_plan_child_parent_run_id_agent_run_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_plan_child" ADD CONSTRAINT "runner_plan_child_agent_id_ai_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_plan_child" ADD CONSTRAINT "runner_plan_child_child_issue_id_issue_id_fk" FOREIGN KEY ("child_issue_id") REFERENCES "public"."issue"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_plan_child" ADD CONSTRAINT "runner_plan_child_child_run_id_agent_run_id_fk" FOREIGN KEY ("child_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;