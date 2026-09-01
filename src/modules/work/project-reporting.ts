import type { MilestoneStatus } from './goals-milestones';

export type ReportingDailyEntry = {
  id: string;
  date: string;
  category: string;
  description: string;
};

export type ReportingPriority = {
  id: string;
  title: string;
  status: string;
  approvalStatus: string;
  isAdditional: boolean;
  dailyEntries: ReportingDailyEntry[];
};

export type ReportingEmployee = {
  employeeId: string;
  fullName: string;
  priorities: ReportingPriority[];
};

export type ReportingMilestone = {
  id: string;
  name: string;
  status: MilestoneStatus;
  employees: ReportingEmployee[];
};

export type ReportingGoal = {
  id: string;
  name: string;
  milestones: ReportingMilestone[];
};

type ReportingPriorityInput = {
  id: string;
  employeeId: string;
  employeeName: string;
  title: string;
  status: string;
  approvalStatus: string;
  milestoneId: string | null;
  isAdditional: boolean;
};

type ReportingDailyInput = {
  id: string;
  date: string;
  employeeId: string;
  category: string;
  description: string;
  priorityId: string | null;
};

type ReportingGoalInput = {
  id: string;
  name: string;
  sequence: number;
  milestones: {
    id: string;
    name: string;
    status: MilestoneStatus;
    sequence: number;
  }[];
};

/** Project → Goal → Milestone → Employee → Weekly priority → Daily work */
export function buildProjectReportingChain(input: {
  goals: ReportingGoalInput[];
  priorities: ReportingPriorityInput[];
  dailyEntries: ReportingDailyInput[];
}): ReportingGoal[] {
  const dailyByPriority = new Map<string, ReportingDailyEntry[]>();
  for (const entry of input.dailyEntries) {
    if (!entry.priorityId) continue;
    const list = dailyByPriority.get(entry.priorityId) ?? [];
    list.push({
      id: entry.id,
      date: entry.date,
      category: entry.category,
      description: entry.description,
    });
    dailyByPriority.set(entry.priorityId, list);
  }

  const prioritiesByMilestone = new Map<string, ReportingPriorityInput[]>();
  for (const priority of input.priorities) {
    if (!priority.milestoneId) continue;
    const list = prioritiesByMilestone.get(priority.milestoneId) ?? [];
    list.push(priority);
    prioritiesByMilestone.set(priority.milestoneId, list);
  }

  return [...input.goals]
    .sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name))
    .map((goal) => ({
      id: goal.id,
      name: goal.name,
      milestones: [...goal.milestones]
        .sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name))
        .map((milestone) => {
          const milestonePriorities = prioritiesByMilestone.get(milestone.id) ?? [];
          const byEmployee = new Map<string, ReportingEmployee>();
          for (const priority of milestonePriorities) {
            const employee =
              byEmployee.get(priority.employeeId) ??
              ({
                employeeId: priority.employeeId,
                fullName: priority.employeeName,
                priorities: [],
              } as ReportingEmployee);
            employee.priorities.push({
              id: priority.id,
              title: priority.title,
              status: priority.status,
              approvalStatus: priority.approvalStatus,
              isAdditional: priority.isAdditional,
              dailyEntries: dailyByPriority.get(priority.id) ?? [],
            });
            byEmployee.set(priority.employeeId, employee);
          }
          return {
            id: milestone.id,
            name: milestone.name,
            status: milestone.status,
            employees: [...byEmployee.values()].sort((a, b) => a.fullName.localeCompare(b.fullName)),
          };
        }),
    }));
}
