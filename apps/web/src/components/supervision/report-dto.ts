// Field report HTTP DTOs. IDs are UUID strings; instants are epoch milliseconds.
export type Id<Table extends string> = string & {
  readonly __uuidTable?: Table;
};
export interface Endpoints {
  "dsr.report.team": {
    args: { serviceDate: string };
    result: import("./depth-model").TeamDsr;
  };
  "supervision.team.cockpit": {
    args: Endpoints["supervision.team.day"]["args"];
    result: import("./depth-model").TeamCockpit;
  };
  "supervision.exceptions.queue": {
    args: {
      orgUnitId?: undefined | string;
      channel?: undefined | string;
      directOnly?: undefined | false | true;
      serviceDate: string;
    };
    result: {
      serviceDate: string;
      dayCloseAt: number;
      truncated: false | true;
      canDecide: false | true;
      items: {
        at: null | number;
        history: {
          at: number;
          reasonCode: null | string;
          kind: string;
          actorName: string;
          after: null | string;
        }[];
        id: string;
        profileId: string;
        channel: string;
        result: null | string;
        open: false | true;
        kind:
          | "location"
          | "cancelled"
          | "unplanned"
          | "rescheduled"
          | "nonproductive"
          | "not_visited"
          | "out_of_sequence";
        reason: null | string;
        decision: null | {
          at: number;
          status: string;
          reasonCode: null | string;
          actorName: string;
        };
        radiusMeters: null | number;
        sequence: null | number;
        outletName: string;
        outletCode: string;
        after: null | number;
        visitId: null | string;
        event: null | "check_in" | "check_out";
        accuracyMeters: null | number;
        distanceMeters: null | number;
        personName: string;
        canDecide: false | true;
        evidenceId: null | string;
      }[];
    };
  };
  "visits.location.decideLocationException": {
    args: {
      reason: string;
      decision: "approve" | "reject";
      evidenceId: string;
    };
    result: { reviewStatus: "rejected" | "approved_exception" };
  };
  "supervision.per_diem.validation": {
    args: {
      orgUnitId?: undefined | string;
      profileId?: undefined | string;
      channel?: undefined | string;
      directOnly?: undefined | false | true;
      from: string;
      to: string;
    };
    result: {
      localMonth: string;
      from: string;
      to: string;
      ruleVersion: string;
      truncated: false | true;
      people: {
        profileId: string;
        name: string;
        employeeCode: null | string;
        positionLabel: null | string;
        channel: string;
        latest: null | {
          decision: "returned" | "validated";
          decidedAt: number;
        };
      }[];
      selected: null | {
        profileId: string;
        name: string;
        positionLabel: null | string;
        canDecide: false | true;
        truncated: false | true;
        contentHash: string;
        totals: {
          plannedStops: number;
          validCalls: number;
          heldCalls: number;
          invalidCalls: number;
          notVisited: number;
          validDays: number;
          heldDays: number;
        };
        days: {
          serviceDate: string;
          plannedStops: number;
          validCalls: number;
          heldCalls: number;
          invalidCalls: number;
          notVisited: number;
          dayStatus: "valid" | "held" | "none";
        }[];
        items: {
          productivity: null | string;
          id: string;
          status: "valid" | "held" | "invalid";
          serviceDate: string;
          kind: "visit" | "not_visited";
          notes: (
            | "location_unreviewed"
            | "late_accepted"
            | "location_exception_approved"
          )[];
          sequence: null | number;
          outletName: string;
          outletCode: string;
          checkedInAt: null | number;
          visitId: null | string;
          reasons: (
            | "not_visited"
            | "outside_mcp"
            | "removed_from_plan"
            | "plan_not_approved"
            | "not_completed"
            | "still_open"
            | "no_location"
            | "location_rejected"
            | "late_pending"
            | "late_rejected"
            | "no_report"
            | "no_call_sheet"
            | "forms_missing"
          )[];
          missingForms: string[];
        }[];
        decisions: {
          id: string;
          decision: "returned" | "validated";
          note: null | string;
          deciderName: string;
          decidedAt: number;
          validCalls: number;
          validDays: number;
          ruleVersion: string;
          stale: false | true;
        }[];
      };
    };
  };
  "supervision.per_diem.decide": {
    args: {
      note?: undefined | string;
      profileId: string;
      decision: "returned" | "validated";
      contentHash: string;
      from: string;
      to: string;
    };
    result: string;
  };
  "analytics.productivity.person": {
    args: { profileId: string; from: string; to: string };
    result: {
      profileId: string;
      name: string;
      employeeCode: null | string;
      positionLabel: null | string;
      channel: string;
      direct: false | true;
      from: string;
      to: string;
      productiveCallTargetPct: null | number;
      sourceRef: string;
      figures: {
        days: number;
        sellingDays: number;
        planned: number;
        plannedDone: number;
        calls: number;
        productiveCalls: number;
        convertedCalls: number;
        missed: number;
        pending: number;
        visits: number;
        unplanned: number;
        exceptionVisits: number;
        locationExceptions: number;
        outOfSequence: number;
        orders: number;
        sales: number;
        callsTarget: null | number;
      };
      days: {
        serviceDate: string;
        closed: false | true;
        sellingDay: false | true;
        planned: number;
        plannedDone: number;
        calls: number;
        productiveCalls: number;
        convertedCalls: number;
        visits: number;
        unplanned: number;
        exceptionVisits: number;
        locationExceptions: number;
        outOfSequence: number;
        orders: number;
        sales: number;
        callsTarget: null | number;
      }[];
    };
  };
  "analytics.productivity.roster": {
    args: {
      orgUnitId?: undefined | string;
      channel?: undefined | string;
      directOnly?: undefined | false | true;
      endDate: string;
    };
    result: {
      truncated: false | true;
      directReports: number;
      people: {
        profileId: string;
        name: string;
        employeeCode: null | string;
        positionLabel: null | string;
        channel: string;
        direct: false | true;
      }[];
    };
  };
  "supervision.talk_sheet.detail": {
    args: { sheetId: string };
    result: {
      sheet: {
        _id: string;
        _creationTime: number;
        nextContactDate?: undefined | string;
        acknowledgedByName?: undefined | string;
        previousSheetId?: undefined | string;
        finalizedAt?: undefined | number;
        status: "draft" | "final";
        orgUnitId: string;
        updatedAt: number;
        organizationId: string;
        createdAt: number;
        createdBy: string;
        updatedBy: string;
        partnerName: string;
        partnerKey: string;
        ownerProfileId: string;
        meetingDate: string;
      };
      ownerName: string;
      previousMeetingDate: null | string;
      items: {
        item: {
          _id: string;
          _creationTime: number;
          rootCause?: undefined | string;
          originItemId?: undefined | string;
          carriedFromItemId?: undefined | string;
          status: "completed" | "on_going" | "overdue";
          organizationId: string;
          topic:
            | "siv_stt"
            | "buying_accounts"
            | "program_utilization"
            | "report_submission"
            | "inventory_days"
            | "marketing_program"
            | "other_operational";
          sheetId: string;
          position: number;
          gap: string;
          agreement: string;
          correctiveAction: string;
          responsible: string;
          timeline: string;
          openedOn: string;
        };
        effectiveStatus: "completed" | "on_going" | "overdue";
        carried: false | true;
        daysOpen: number;
        rootCauseDue: false | true;
      }[];
      gaps: {
        code:
          | "acknowledged_by"
          | "next_contact"
          | "no_items"
          | "item_gap"
          | "item_agreement"
          | "item_action"
          | "item_responsible"
          | "item_timeline"
          | "root_cause";
        label:
          | "Name who acknowledged and committed for the partner"
          | "Set the next contact date after the meeting"
          | "Add at least one gap or issue"
          | "Describe every gap or issue"
          | "Write the agreement for every line"
          | "Write the corrective action for every line"
          | "Name who is responsible for every line"
          | "Give every line a timeline date"
          | "Write the root-cause review for lines open over a month";
      }[];
      canEdit: false | true;
    };
  };
  "supervision.talk_sheet.save": {
    args: {
      nextContactDate?: undefined | string;
      acknowledgedByName?: undefined | string;
      items?:
        | undefined
        | {
            rootCause?: undefined | string;
            itemId?: undefined | string;
            status: "completed" | "on_going" | "overdue";
            topic:
              | "siv_stt"
              | "buying_accounts"
              | "program_utilization"
              | "report_submission"
              | "inventory_days"
              | "marketing_program"
              | "other_operational";
            gap: string;
            agreement: string;
            correctiveAction: string;
            responsible: string;
            timeline: string;
          }[];
      sheetId: string;
    };
    result: null;
  };
  "supervision.talk_sheet.finalize": {
    args: { sheetId: string };
    result: null;
  };
  "supervision.talk_sheet.discard": { args: { sheetId: string }; result: null };
  "supervision.talk_sheet.mine": {
    args: Record<string, never>;
    result: {
      sheets: {
        sheetId: string;
        partnerName: string;
        meetingDate: string;
        nextContactDate: null | string;
        status: "draft" | "final";
        carriedFrom: null | string;
      }[];
      partners: string[];
    };
  };
  "supervision.talk_sheet.create": {
    args: { partnerName: string; meetingDate: string };
    result: string;
  };
  "supervision.talk_sheet.register": {
    args: {
      orgUnitId?: undefined | string;
      channel?: undefined | string;
      directOnly?: undefined | false | true;
      serviceDate: string;
    };
    result: {
      today: string;
      truncated: false | true;
      chains: {
        latestSheetId: string;
        partnerName: string;
        orgUnitId: string;
        unitName: string;
        ownerName: string;
        lastMeetingDate: null | string;
        nextContactDate: null | string;
        contactOverdue: false | true;
        draftSheetId: null | string;
        openCount: number;
        overdueCount: number;
        rootCauseCount: number;
      }[];
      openItems: {
        itemId: string;
        sheetId: string;
        partnerName: string;
        ownerName: string;
        topic:
          | "siv_stt"
          | "buying_accounts"
          | "program_utilization"
          | "report_submission"
          | "inventory_days"
          | "marketing_program"
          | "other_operational";
        gap: string;
        responsible: string;
        timeline: string;
        status: "on_going" | "overdue";
        openedOn: string;
        daysOpen: number;
        rootCauseDue: false | true;
        rootCause: null | string;
      }[];
    };
  };
  "lib.capabilities.currentPermissions": {
    args: Record<string, never>;
    result: {
      version: 1;
      role:
        | "admin"
        | "sales"
        | "super_admin"
        | "operations"
        | "manager"
        | "approver"
        | "analyst"
        | "viewer";
      orgUnitId: null | string;
      scopeUnitIds: string[];
      capabilities: string[];
    };
  };
  "supervision.team.day": {
    args: {
      orgUnitId?: undefined | string;
      channel?: undefined | string;
      directOnly?: undefined | false | true;
      serviceDate: string;
    };
    result: {
      serviceDate: string;
      dayCloseAt: number;
      truncated: false | true;
      canDecide: false | true;
      units: { id: string; code: string; name: string }[];
      channels: string[];
      people: {
        planned: number;
        plannedDone: number;
        done: number;
        productive: number;
        nonproductive: number;
        unplanned: number;
        inProgress: false | true;
        outOfSequence: number;
        openExceptions: number;
        lateSync: number;
        firstCheckInAt: null | number;
        lastCheckOutAt: null | number;
        lastActivityAt: null | number;
        profileId: string;
        name: string;
        employeeCode: null | string;
        positionLabel: null | string;
        channel: string;
        orgUnitId: string;
        direct: false | true;
      }[];
    };
  };
  "supervision.trainer_forms.detail": {
    args: { formId: string };
    result: {
      form: {
        _id: string;
        _creationTime: number;
        acknowledgedAt?: undefined | number;
        program?:
          | undefined
          | {
              area: string;
              strengths: string;
              objectives: string[];
              improvementAreas: string;
              plansForNextContact: string;
            };
        sheet?:
          | undefined
          | {
              result: string;
              objective: string;
              learnings: string;
              nextSteps: string;
            };
        evaluation?:
          | undefined
          | {
              overall?: undefined | 1 | 2 | 3 | 4;
              area: string;
              remarks: string;
              periodStart: string;
              periodEnd: string;
              district: string;
              ratings: { item: string; rating: 1 | 2 | 3 | 4 }[];
            };
        evaluationSessions?:
          undefined | { sessionId: string; serviceDate: string }[];
        signedAt?: undefined | number;
        signedBy?: undefined | string;
        acknowledgedBy?: undefined | string;
        traineeComment?: undefined | string;
        status: "draft" | "signed" | "acknowledged";
        orgUnitId: string;
        updatedAt: number;
        organizationId: string;
        createdAt: number;
        createdBy: string;
        sessionId: string;
        serviceDate: string;
        kind: "training_program" | "training_sheet" | "job_evaluation";
        updatedBy: string;
        trainerProfileId: string;
        traineeProfileId: string;
      };
      trainerName: string;
      traineeName: string;
      sessionStatus: "cancelled" | "completed" | "open";
      gaps: {
        code:
          | "area"
          | "result"
          | "objective"
          | "strengths"
          | "objectives"
          | "learnings"
          | "overall"
          | "period"
          | "next_contact"
          | "improvement_areas"
          | "next_steps"
          | "section_unrated";
        label:
          | "Write the area"
          | "Write at least one training objective"
          | "Write the strengths"
          | "Write the areas needing improvement"
          | "Write the training plans for the next contact"
          | "Write the objective"
          | "Write the result"
          | "Write the learnings"
          | "Write the next steps"
          | "Give a training period that includes the Work-With day"
          | "Rate at least one item in every section"
          | "Rate the overall job standard";
      }[];
      canEdit: false | true;
      canAcknowledge: false | true;
    };
  };
  "supervision.trainer_forms.program": {
    args: { traineeProfileId: string };
    result: {
      traineeName: string;
      blocks: {
        formId: string;
        serviceDate: string;
        trainerName: string;
        status: "signed" | "acknowledged";
        program: {
          area: string;
          strengths: string;
          objectives: string[];
          improvementAreas: string;
          plansForNextContact: string;
        };
      }[];
      latestEvaluation: null | {
        formId: string;
        serviceDate: string;
        trainerName: string;
        evaluation: {
          overall?: undefined | 1 | 2 | 3 | 4;
          area: string;
          remarks: string;
          periodStart: string;
          periodEnd: string;
          district: string;
          ratings: { item: string; rating: 1 | 2 | 3 | 4 }[];
        };
      };
    };
  };
  "supervision.trainer_forms.update": {
    args: {
      program?:
        | undefined
        | {
            area: string;
            strengths: string;
            objectives: string[];
            improvementAreas: string;
            plansForNextContact: string;
          };
      sheet?:
        | undefined
        | {
            result: string;
            objective: string;
            learnings: string;
            nextSteps: string;
          };
      evaluation?:
        | undefined
        | {
            overall?: undefined | 1 | 2 | 3 | 4;
            area: string;
            remarks: string;
            periodStart: string;
            periodEnd: string;
            district: string;
            ratings: { item: string; rating: 1 | 2 | 3 | 4 }[];
          };
      formId: string;
    };
    result: null;
  };
  "supervision.trainer_forms.sign": { args: { formId: string }; result: null };
  "supervision.trainer_forms.discard": {
    args: { formId: string };
    result: null;
  };
  "supervision.trainer_forms.acknowledge": {
    args: { comment?: undefined | string; formId: string };
    result: null;
  };
  "supervision.trainer_forms.forSession": {
    args: { sessionId: string };
    result: {
      forms: {
        formId: string;
        kind: "training_program" | "training_sheet" | "job_evaluation";
        sessionId: string;
        serviceDate: string;
        status: "draft" | "signed" | "acknowledged";
        trainerName: string;
        traineeName: string;
      }[];
      canCreate: false | true;
    };
  };
  "supervision.trainer_forms.create": {
    args: {
      sessionId: string;
      kind: "training_program" | "training_sheet" | "job_evaluation";
    };
    result: string;
  };
  "domains.profiles.current": {
    args: Record<string, never>;
    result: null | {
      _id: string;
      _creationTime: number;
      orgUnitId?: undefined | string;
      employeeCode?: undefined | string;
      positionId?: undefined | string;
      employmentType?:
        undefined | "sfi_employee" | "adp_personnel" | "third_party";
      channelScope?: undefined | string;
      supervisorSubject?: undefined | string;
      effectiveFrom?: undefined | number;
      role:
        | "admin"
        | "sales"
        | "super_admin"
        | "operations"
        | "manager"
        | "approver"
        | "analyst"
        | "viewer";
      authSubject: string;
      name: string;
      email: string;
      status: "active" | "disabled";
      updatedAt: number;
    };
  };
  "supervision.trainer_forms.mine": {
    args: Record<string, never>;
    result: {
      toAcknowledge: {
        formId: string;
        kind: "training_program" | "training_sheet" | "job_evaluation";
        sessionId: string;
        serviceDate: string;
        status: "draft" | "signed" | "acknowledged";
        trainerName: string;
        traineeName: string;
      }[];
      received: {
        formId: string;
        kind: "training_program" | "training_sheet" | "job_evaluation";
        sessionId: string;
        serviceDate: string;
        status: "draft" | "signed" | "acknowledged";
        trainerName: string;
        traineeName: string;
      }[];
      written: {
        formId: string;
        kind: "training_program" | "training_sheet" | "job_evaluation";
        sessionId: string;
        serviceDate: string;
        status: "draft" | "signed" | "acknowledged";
        trainerName: string;
        traineeName: string;
      }[];
    };
  };
  "supervision.work_with.detail": {
    args: { sessionId: string };
    result: {
      session: {
        _id: string;
        _creationTime: number;
        cancelledAt?: undefined | number;
        cancelReason?: undefined | string;
        completedAt?: undefined | number;
        trainerPositionId?: undefined | string;
        truckReference?: undefined | string;
        rodeWithTruck?: undefined | false | true;
        trainingLog?:
          | undefined
          | {
              topics: string;
              tradeDevelopment: string;
              discussedWithTrainee: false | true;
            };
        preCall?:
          | undefined
          | {
              documents: (
                | "productivity"
                | "distribution"
                | "daily_productive_sales_report"
                | "call_sheet"
              )[];
              remarks: string;
            };
        postCall?:
          | undefined
          | {
              strengths: string;
              weaknesses: string;
              opportunities: string;
              threats: string;
            };
        mcpPlanned?: undefined | number;
        mcpDone?: undefined | number;
        status: "cancelled" | "completed" | "open";
        orgUnitId: string;
        updatedAt: number;
        organizationId: string;
        createdAt: number;
        createdBy: string;
        serviceDate: string;
        updatedBy: string;
        objective: "training" | "sales_validation";
        mode: "truck" | "booking";
        trainerProfileId: string;
        traineeProfileId: string;
        observations: {
          remark?: undefined | string;
          area: "bcp" | "psf";
          item: string;
          rating: "partial" | "met" | "not_met";
        }[];
      };
      trainerName: string;
      traineeName: string;
      mcp: { planned: number; done: number };
      gaps: {
        code:
          | "bcp_observation"
          | "psf_observation"
          | "training_log"
          | "trade_development"
          | "training_log_discussed"
          | "pre_call_documents"
          | "pre_call_remarks"
          | "post_call_swot"
          | "mcp_missing"
          | "mcp_unfinished"
          | "truck_missing"
          | "truck_not_ridden";
        label:
          | "Record at least one Basic Call Procedure (BCP) observation"
          | "Record at least one Persuasive Selling Format (PSF) observation"
          | "Write the training log"
          | "Write the trade development remark"
          | "Review and discuss the training log with the trainee"
          | "Pick the reports reviewed before the call"
          | "Write the pre-call review remarks"
          | "Write all four SWOT remarks after the call"
          | "The trainee has no approved MCP stops on this day"
          | "The trainee has not finished the day's MCP"
          | "Name the truck for a truck work-with"
          | "Confirm you rode the named truck";
      }[];
      canEdit: false | true;
    };
  };
  "supervision.work_with.update": {
    args: {
      truckReference?: undefined | string;
      rodeWithTruck?: undefined | false | true;
      trainingLog?:
        | undefined
        | {
            topics: string;
            tradeDevelopment: string;
            discussedWithTrainee: false | true;
          };
      observations?:
        | undefined
        | {
            remark?: undefined | string;
            area: "bcp" | "psf";
            item: string;
            rating: "partial" | "met" | "not_met";
          }[];
      preCall?:
        | undefined
        | {
            documents: (
              | "productivity"
              | "distribution"
              | "daily_productive_sales_report"
              | "call_sheet"
            )[];
            remarks: string;
          };
      postCall?:
        | undefined
        | {
            strengths: string;
            weaknesses: string;
            opportunities: string;
            threats: string;
          };
      sessionId: string;
    };
    result: null;
  };
  "supervision.work_with.complete": {
    args: { sessionId: string };
    result: null;
  };
  "supervision.work_with.cancel": {
    args: { sessionId: string; reason: string };
    result: null;
  };
  "supervision.work_with.mine": {
    args: { serviceDate: string };
    result: {
      sessions: {
        sessionId: string;
        serviceDate: string;
        trainerProfileId: string;
        trainerName: string;
        traineeProfileId: string;
        traineeName: string;
        objective: "training" | "sales_validation";
        mode: "truck" | "booking";
        truckReference: null | string;
        status: "cancelled" | "completed" | "open";
      }[];
      trainees: {
        profileId: string;
        name: string;
        employeeCode: null | string;
      }[];
      traineesTruncated: false | true;
    };
  };
  "supervision.work_with.start": {
    args: {
      truckReference?: undefined | string;
      serviceDate: string;
      objective: "training" | "sales_validation";
      mode: "truck" | "booking";
      traineeProfileId: string;
    };
    result: string;
  };
  "supervision.work_with.cadence": {
    args: {
      orgUnitId?: undefined | string;
      channel?: undefined | string;
      directOnly?: undefined | false | true;
      serviceDate: string;
    };
    result: {
      week: { start: string; end: string };
      month: { start: string; end: string };
      truncated: false | true;
      trainers: {
        profileId: string;
        name: string;
        employeeCode: null | string;
        positionLabel: string;
        orgUnitId: string;
        direct: false | true;
        weeklyMin: null | number;
        monthlyMin: null | number;
        weekCount: number;
        monthCount: number;
        openCount: number;
        weekState: "met" | "behind" | "on_track" | "no_standard";
        monthState: "met" | "behind" | "on_track" | "no_standard";
        sourceRef: string;
      }[];
      sessions: {
        sessionId: string;
        serviceDate: string;
        trainerProfileId: string;
        trainerName: string;
        traineeProfileId: string;
        traineeName: string;
        objective: "training" | "sales_validation";
        mode: "truck" | "booking";
        truckReference: null | string;
        status: "cancelled" | "completed" | "open";
      }[];
    };
  };
  "supervision.activity.map": {
    args: {
      orgUnitId?: undefined | string;
      profileId?: undefined | string;
      channel?: undefined | string;
      directOnly?: undefined | false | true;
      serviceDate: string;
    };
    result: {
      serviceDate: string;
      truncated: false | true;
      showsFixes: false | true;
      people: {
        profileId: string;
        name: string;
        channel: string;
        stops: {
          productivity: null | string;
          id: string;
          source: "unplanned" | "planned" | "not_visited";
          sequence: null | number;
          outletName: string;
          outletCode: string;
          territoryCode: null | string;
          state: string;
          checkedInAt: null | number;
          checkedOutAt: null | number;
          visitId: null | string;
          point: null | { latitude: number; longitude: number };
          fix: null | {
            result: string;
            latitude: number;
            longitude: number;
            accuracyMeters: null | number;
          };
        }[];
      }[];
    };
  };
  "supervision.team.options": {
    args: { serviceDate: string };
    result: {
      canDecide: false | true;
      units: { id: string; code: string; name: string }[];
      channels: string[];
    };
  };
  "callSheets.accounts.list": {
    args: {
      paginationOpts: {
        id?: undefined | number;
        endCursor?: undefined | null | string;
        maximumRowsRead?: undefined | number;
        maximumBytesRead?: undefined | number;
        numItems: number;
        cursor: null | string;
      };
    };
    result: {
      page: {
        outletId: string;
        outletCode: string;
        outletName: string;
        accountName: string;
        lineCount: number;
        revision: number;
        updatedAt: number;
      }[];
      isDone: false | true;
      continueCursor: string;
    };
  };
  "callSheets.accounts.outletByCode": {
    args: { code: string };
    result: null | { id: string; code: string; name: string };
  };
  "callSheets.accounts.detail": {
    args: { outletId: string };
    result: {
      outlet: {
        id: string;
        code: string;
        name: string;
        address: null | string;
        status: "active" | "inactive" | "prospect";
      };
      canEdit: false | true;
      account: null | {
        revision: number;
        updatedAt: number;
        header: {
          pricing: null | string;
          address: null | string;
          accountName: string;
          buyerName: null | string;
          contactNumber: null | string;
          accountInCharge: null | string;
          receivingInCharge: null | string;
          distributorName: null | string;
          distributorSchedule: null | string;
          foc: null | string;
        };
        lines: {
          productId: string;
          code: string;
          name: string;
          uom: string;
          pricing: null | string;
          active: false | true;
        }[];
      };
    };
  };
  "callSheets.report.month": {
    args: { outletId: string; localMonth: string };
    result: {
      outlet: { id: string; code: string; name: string };
      localMonth: string;
      configured: false | true;
      revision: null | number;
      header: {
        pricing: null | string;
        address: null | string;
        accountName: string;
        buyerName: null | string;
        contactNumber: null | string;
        accountInCharge: null | string;
        receivingInCharge: null | string;
        distributorName: null | string;
        distributorSchedule: null | string;
        foc: null | string;
      };
      rows: {
        productId: string;
        code: string;
        name: string;
        uom: string;
        barcode: null | string;
        pricing: null | string;
        onSheet: false | true;
        weeks: {
          order: null | number;
          beginningInventory: null | number;
          take: null | number;
          delivered: null | number;
          offtake: null | number;
          endInventory: null | number;
          week: number;
        }[];
      }[];
      capturedVisits: number;
      lastCapturedAt: null | number;
    };
  };
  "callSheets.accounts.save": {
    args: {
      outletId: string;
      lines: { pricing?: undefined | string; productId: string }[];
      header: {
        pricing?: undefined | string;
        address?: undefined | string;
        buyerName?: undefined | string;
        contactNumber?: undefined | string;
        accountInCharge?: undefined | string;
        receivingInCharge?: undefined | string;
        distributorName?: undefined | string;
        distributorSchedule?: undefined | string;
        foc?: undefined | string;
        accountName: string;
      };
      expectedRevision: null | number;
    };
    result: { revision: number };
  };
  "callSheets.accounts.productSearch": {
    args: { prefix: string };
    result: {
      productId: string;
      code: string;
      name: string;
      uom: string;
      category: string;
    }[];
  };
  "dsr.report.salesmen": {
    args: { serviceDate: string };
    result: {
      self: false | true;
      truncated: false | true;
      people: {
        profileId: string;
        name: string;
        employeeCode: null | string;
        position: null | string;
      }[];
    };
  };
  "dsr.report.day": {
    args: { profileId: string; serviceDate: string };
    result: {
      serviceDate: string;
      localMonth: string;
      ruleVersion: string;
      salesman: {
        profileId: string;
        name: string;
        employeeCode: null | string;
        position: null | string;
      };
      areaCovered: string[];
      invoiceNumbers: string[];
      sellingDay: false | true;
      sellingDaysInMonth: number;
      targets: {
        daily: null | number;
        dailySource: null | "set" | "derived_from_monthly";
        monthly: null | number;
        sourceRef: null | string;
      };
      totals: {
        todaySales: number;
        todayPct: null | number;
        mtdSales: number;
        mtdPct: null | number;
        balanceToSell: null | number;
      };
      calls: {
        dailyCallsTarget: null | number;
        productiveCallTargetPct: null | number;
        productiveCallRule: "any_listed_activity" | "truck_seller";
        calls: number;
        productiveCalls: number;
        productivePct: null | number;
        planned: number;
      };
      customers: {
        name: string;
        reasonCode: null | string;
        outletId: null | string;
        customerCode: null | string;
        key: string;
        sequence: null | number;
        outletCode: null | string;
        remarks: string[];
        invoiceNumbers: string[];
        todaySales: number;
        mtdSales: number;
        inRoutePlan: false | true;
        callStatus:
          | null
          | "open"
          | "nonproductive"
          | "not_visited"
          | "productive"
          | "off_plan";
        matchedCodes: string[];
      }[];
      categories: {
        todaySales: number;
        todayQuantity: number;
        mtdSales: number;
        mtdQuantity: number;
        category: string;
      }[];
      programs: {
        executed: number;
        notExecuted: number;
        notApplicable: number;
        programRef: string;
      }[];
    };
  };
  "field_reports.reports.day": {
    args: { profileId?: undefined | string; serviceDate: string };
    result: null | {
      routes: {
        routeCode: null | string;
        calls: number;
        productiveCalls: number;
        productivePct: null | number;
        routeName: null | string;
      }[];
      status: "submitted" | "missing" | "due" | "late" | "off_day" | "upcoming";
      serviceDate: string;
      kind: "dar" | "roar";
      sourceRef: string;
      summary: {
        unplanned: number;
        planned: number;
        calls: number;
        productiveCalls: number;
        workWithSessions: number;
        notVisited: number;
        plannedDone: number;
        productivePct: null | number;
        workWithCompleted: number;
        firstCheckInAt: null | number;
        lastCheckOutAt: null | number;
        fieldMinutes: null | number;
      };
      sellingDay: false | true;
      person: {
        name: string;
        employeeCode: null | string;
        profileId: string;
        positionLabel: string;
        unitName: null | string;
        positionCode: string;
      };
      dueAt: number;
      canSubmit: false | true;
      submitBlockedReason: null | string;
      standard: null | {
        sourceRef: string;
        dailyCallsTarget: null | number;
        productiveCallTargetPct: null | number;
      };
      callsTargetMet: null | false | true;
      productiveTargetMet: null | false | true;
      stops: {
        reasonCode: null | string;
        routeCode: null | string;
        notes: string[];
        key: string;
        collections: number;
        source: "unplanned" | "planned" | "not_visited";
        sequence: null | number;
        outletName: string;
        outletCode: string;
        state: string;
        checkedInAt: null | number;
        checkedOutAt: null | number;
        callStatus: string;
        matchedCodes: string[];
        activityKinds: string[];
        callMinutes: null | number;
      }[];
      workWith: {
        status: string;
        sessionId: string;
        objective: string;
        mode: string;
        mcpPlanned: null | number;
        mcpDone: null | number;
        traineeName: string;
      }[];
      submission: null | {
        submittedAt: number;
        remarks: string;
        summary: {
          unplanned: number;
          planned: number;
          calls: number;
          productiveCalls: number;
          workWithSessions: number;
          notVisited: number;
          plannedDone: number;
          productivePct: null | number;
          workWithCompleted: number;
          firstCheckInAt: null | number;
          lastCheckOutAt: null | number;
          fieldMinutes: null | number;
        };
        revision: number;
        submittedByName: string;
        firstSubmittedAt: number;
      };
      revisions: number;
    };
  };
  "field_reports.reports.submit": {
    args: { serviceDate: string; remarks: string };
    result: {
      revision: number;
      late: false | true;
      summary: {
        unplanned: number;
        planned: number;
        calls: number;
        productiveCalls: number;
        workWithSessions: number;
        notVisited: number;
        plannedDone: number;
        productivePct: null | number;
        workWithCompleted: number;
        firstCheckInAt: null | number;
        lastCheckOutAt: null | number;
        fieldMinutes: null | number;
      };
    };
  };
  "field_reports.reports.completeness": {
    args: {
      orgUnitId?: undefined | string;
      kind?: undefined | "dar" | "roar";
      days?: undefined | number;
      endDate: string;
    };
    result: {
      dates: string[];
      truncated: false | true;
      units: { id: string; code: string; name: string }[];
      people: {
        name: string;
        employeeCode: null | string;
        profileId: string;
        kind: "dar" | "roar";
        positionLabel: string;
        days: {
          status:
            "submitted" | "missing" | "due" | "late" | "off_day" | "upcoming";
          serviceDate: string;
          submittedAt: null | number;
          revisions: number;
        }[];
      }[];
      totals: {
        serviceDate: string;
        required: number;
        submitted: number;
        late: number;
        missing: number;
      }[];
    };
  };
  "field_reports.reports.myKind": {
    args: Record<string, never>;
    result: null | "dar" | "roar";
  };
}
