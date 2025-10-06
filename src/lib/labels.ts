// 가용표에 보여줄 한글 라벨/우선순위/색상
export type AssignmentType = 'OFF' | 'SICK' | 'LONG_SICK' | 'DUTY' | 'MARSHAL';

export const typeLabel: Record<AssignmentType, string> = {
  OFF: '휴무',
  SICK: '병가',
  LONG_SICK: '장기병가',
  DUTY: '당번',
  MARSHAL: '마샬',
};

// 우선순위: 휴무 > 병가 > 장기병가 > 당번 > 마샬
export const typePriority: Record<AssignmentType, number> = {
  OFF: 100,
  SICK: 90,
  LONG_SICK: 80,
  DUTY: 50,
  MARSHAL: 40,
};

// table 컬러용(선택사항)
export const typeClass: Record<AssignmentType, string> = {
  OFF: 'bg-gray-100',
  SICK: 'bg-yellow-100',
  LONG_SICK: 'bg-rose-100',
  DUTY: 'bg-blue-100',
  MARSHAL: 'bg-green-100',
};
