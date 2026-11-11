import { tableFeatures, useTable, type ColumnDef, type RowData } from "@tanstack/react-table";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "./ui/table";
export const dataTableFeatures = tableFeatures({});
export type DataColumn<T extends RowData> = ColumnDef<typeof dataTableFeatures, T>;
export function DataTable<T extends RowData>({
  columns,
  data,
  caption,
}: {
  columns: DataColumn<T>[];
  data: T[];
  caption: string;
}) {
  const table = useTable({ features: dataTableFeatures, columns, data });
  return (
    <Table>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => (
              <TableHead key={header.id}>
                {header.isPlaceholder ? null : <table.FlexRender header={header} />}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id}>
            {row.getAllCells().map((cell) => (
              <TableCell key={cell.id}>
                <table.FlexRender cell={cell} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
